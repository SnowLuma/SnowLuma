import type { PacketInfo } from '@snowluma/common/protocol-types';
import { formatEvent } from './format';
import { createLogger, type Logger } from '@snowluma/common/logger';
import type { BridgeEventBus } from './event-bus';
import type { QQEventVariant } from './events';
import type { IdentityService } from './identity-service';

const moduleLog = createLogger('Bridge');
const moduleEventLog = createLogger('Event');

// Notice kinds that get logged as a warning (operationally important
// state changes that an operator probably wants to see at default
// info level). Everything else falls through to info.
const WARN_EVENT_KINDS = new Set([
  'group_recall',
  'friend_recall',
  'group_member_leave',
  'group_mute',
  'friend_request',
  'group_invite',
]);

type GroupMemberIdentityEvent = Extract<QQEventVariant, { kind: 'group_member_join' | 'group_member_leave' }>;

export type CmdParser = (pkt: PacketInfo, identity: IdentityService) => QQEventVariant[];

export interface PacketPipelineDeps {
  identity: IdentityService;
  events: BridgeEventBus;
  /**
   * Refresh group + member roster as a side-effect. Resolves with
   * whether any refresh actually ran (false when the group is unknown
   * and `refreshGroupList` was false).
   */
  refreshMemberCache(groupId: number, refreshGroupList: boolean, forceMemberList: boolean): Promise<boolean>;
  /**
   * Resolve a stranger profile by UID — used to fill in the requester's
   * uin + nickname on group-join-request and friend-request events
   * where the push only carries a uid. Mirrors Lagrange's
   * `FetchUserInfoEvent.Create(targetUid)` path
   * (`dev/Lagrange.Core/.../MessagingLogic.cs:215-224`). Returns null
   * on lookup failure so the dispatch path can proceed with the bare
   * uid-only event.
   */
  resolveStrangerProfile(uid: string): Promise<{ uin: number; nickname: string } | null>;
  /**
   * Resolve the verify message ("postscript") + server sequence number
   * for a pending group-join / group-invite. The OIDB push only
   * carries the requester's UID + group uin — the actual verify text
   * the user typed ("你们好" etc.) lives on the pending-request queue
   * fetched via OIDB 0x10C0. NapCat surfaces this as
   * `notify.postscript` from `nodeIKernelGroupService.getGroupNotifies`;
   * we mirror that with an `fetchGroupRequests` lookup matched on
   * `(groupId, uid, subType)`. Returns null when no matching pending
   * request exists (e.g. it was already handled by another client).
   */
  resolveGroupJoinRequest(
    groupId: number, uid: string, subType: 'add' | 'invite',
  ): Promise<{ comment: string; sequence: number } | null>;
}

export class IncomingPacketPipeline {
  private cmdHandlers_ = new Map<string, CmdParser[]>();
  private memberRefreshTasks_ = new Map<number, Promise<void>>();
  private readonly log: Logger;
  private readonly eventLog: Logger;

  constructor(private readonly deps: PacketPipelineDeps) {
    // Tag every line we emit with this Bridge's UIN so per-account file
    // routing works. Unparseable uin (shouldn't happen) falls back to
    // the module-level logger so we still log, just without the slot.
    const uinNum = Number.parseInt(deps.identity.uin, 10);
    const bind = Number.isFinite(uinNum) && uinNum > 0 ? { uin: uinNum } : null;
    this.log = bind ? moduleLog.child(bind) : moduleLog;
    this.eventLog = bind ? moduleEventLog.child(bind) : moduleEventLog;
  }

  registerCmd(cmd: string, parser: CmdParser): void {
    const arr = this.cmdHandlers_.get(cmd) ?? [];
    arr.push(parser);
    this.cmdHandlers_.set(cmd, arr);
  }

  handlesCmd(cmd: string): boolean {
    return this.cmdHandlers_.has(cmd);
  }

  process(pkt: PacketInfo): void {
    const handlers = this.cmdHandlers_.get(pkt.serviceCmd);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        const events = handler(pkt, this.deps.identity);
        for (const event of events) {
          if (this.needsPreDispatchIdentityRefresh(event)) {
            void this.dispatchAfterIdentityRefresh(event).catch((err) => {
              this.log.warn('dispatchAfterIdentityRefresh failed: %s',
                err instanceof Error ? (err.stack ?? err.message) : String(err));
            });
          } else if (this.needsGroupInviteEnrich(event)) {
            void this.dispatchGroupInvite(event).catch((err) => {
              this.log.warn('dispatchGroupInvite failed: %s',
                err instanceof Error ? (err.stack ?? err.message) : String(err));
            });
          } else {
            this.handleSideEffects(event);
            printEvent(this.eventLog, this.deps.identity, event);
            this.emit(event);
          }
        }
      } catch (e) {
        this.log.error('handler error for %s: %s', pkt.serviceCmd, e instanceof Error ? (e.stack ?? e.message) : String(e));
      }
    }
  }

  private emit(event: QQEventVariant): void {
    // Fire-and-forget: errors inside subscribers are surfaced via the bus's
    // own onError hook so one bad listener never blocks the others.
    void this.deps.events.emit(event);
  }

  private needsPreDispatchIdentityRefresh(event: QQEventVariant): event is Extract<QQEventVariant, { kind: 'group_member_join' }> {
    return event.kind === 'group_member_join' && event.groupId > 0 && event.userUin <= 0 && Boolean(event.userUid);
  }

  /** Every group_invite that carries a requester UID gets async
   *  enrichment before dispatch. Two INDEPENDENT things are filled in:
   *
   *   1. The verify COMMENT — the text the requester typed ("你们好" etc.).
   *      It is NEVER in the push; it lives on the OIDB pending-request
   *      queue, so we ALWAYS fetch it (mirrors Lagrange's unconditional
   *      `FetchGroupRequests`; NapCat reads the equivalent
   *      `notify.postscript`). See issue #98.
   *   2. The requester's UIN + nickname — only when not already resolved
   *      (the push carries a bare UID). Mirrors Lagrange's
   *      `dev/Lagrange.Core/.../MessagingLogic.cs:215-224`.
   *
   *  These USED to be coupled — the comment fetch piggy-backed on the
   *  uin-resolve condition, so a requester whose uin was already cached
   *  silently lost their comment (bug #98). They're now decoupled inside
   *  `dispatchGroupInvite`; this guard just routes every uid-bearing
   *  group_invite onto the async path. */
  private needsGroupInviteEnrich(event: QQEventVariant): event is Extract<QQEventVariant, { kind: 'group_invite' }> {
    return event.kind === 'group_invite' && !!event.fromUid;
  }

  private async dispatchAfterIdentityRefresh(event: Extract<QQEventVariant, { kind: 'group_member_join' }>): Promise<void> {
    let refreshed = false;
    try {
      refreshed = await this.prepareGroupMemberJoinIdentity(event);
    } catch (e) {
      this.log.warn('failed to resolve group member join identity: group=%d uid=%s err=%s',
        event.groupId, event.userUid ?? '', e instanceof Error ? e.message : String(e));
    }

    this.handleSideEffects(event, refreshed);
    printEvent(this.eventLog, this.deps.identity, event);
    this.emit(event);
  }

  private async dispatchGroupInvite(event: Extract<QQEventVariant, { kind: 'group_invite' }>): Promise<void> {
    const uid = event.fromUid;
    if (uid) {
      // Record the requester's identity up-front (synchronously), mirroring the
      // friend_request path — uid-bearing group_invites take this async branch
      // and would otherwise never store the inviter's uid↔uin when the uin is
      // already known (needsProfile=false). uin equal to the group's own uin is
      // the legacy decoder-pollution signature → pass 0 so the map write is
      // skipped (rememberUidUin short-circuits on uin <= 0).
      this.deps.identity.rememberRequestIdentity({
        groupId: event.groupId,
        uid,
        uin: event.fromUin > 0 && event.fromUin !== event.groupId ? event.fromUin : 0,
        source: 'group_request',
      });

      const subType = event.subType === 'invite' ? 'invite' : 'add';
      // ALWAYS fetch the verify comment (it's never in the push). Resolve
      // the UID→UIN profile only when the requester isn't already known —
      // `fromUin === groupId` is the legacy cache-pollution signature
      // (decoder fell back to the group's own uin) and must force a
      // re-resolve so the cache self-heals. The two are independent OIDB
      // calls (0xFE1_2 profile + 0x10C0 request queue); `Promise.allSettled`
      // so a flake on one path can't kill the other.
      const needsProfile = event.fromUin <= 0 || (event.groupId > 0 && event.fromUin === event.groupId);
      const [profileR, requestR] = await Promise.allSettled([
        needsProfile ? this.deps.resolveStrangerProfile(uid) : Promise.resolve(null),
        this.deps.resolveGroupJoinRequest(event.groupId, uid, subType),
      ]);

      if (needsProfile) {
        if (profileR.status === 'fulfilled' && profileR.value && profileR.value.uin > 0) {
          event.fromUin = profileR.value.uin;
          // uin was unknown/polluted at entry; now resolved → self-heal the map.
          this.deps.identity.rememberRequestIdentity({
            groupId: event.groupId,
            uid,
            uin: event.fromUin,
            source: 'group_request',
          });
        } else if (profileR.status === 'rejected') {
          this.log.warn('failed to resolve stranger profile: uid=%s err=%s',
            uid, profileR.reason instanceof Error ? profileR.reason.message : String(profileR.reason));
        }
      }

      if (requestR.status === 'fulfilled' && requestR.value) {
        // The verify text the requester typed; NapCat surfaces it as
        // `notify.postscript`. Without this the OneBot `comment` field is
        // empty — bug #98.
        event.message = requestR.value.comment;
      } else if (requestR.status === 'rejected') {
        this.log.warn('failed to resolve group join request: groupId=%d uid=%s err=%s',
          event.groupId, uid,
          requestR.reason instanceof Error ? requestR.reason.message : String(requestR.reason));
      }
    }

    this.handleSideEffects(event);
    printEvent(this.eventLog, this.deps.identity, event);
    this.emit(event);
  }

  private async prepareGroupMemberJoinIdentity(event: Extract<QQEventVariant, { kind: 'group_member_join' }>): Promise<boolean> {
    this.resolveMemberIdentityFromCache(event);
    if (event.userUin > 0 || !event.userUid || event.groupId <= 0) return false;

    const refreshed = await this.deps.refreshMemberCache(
      event.groupId,
      !this.deps.identity.findGroup(event.groupId) || this.isSelfMemberIdentity(event.userUin, event.userUid),
      true,
    );
    this.resolveMemberIdentityFromCache(event);
    return refreshed;
  }

  private resolveMemberIdentityFromCache(event: GroupMemberIdentityEvent): void {
    if (event.groupId <= 0) return;
    if (event.userUin <= 0 && event.userUid) {
      const uin = this.deps.identity.findUinByUid(event.userUid, event.groupId);
      if (uin !== null) event.userUin = uin;
    }
    if (event.operatorUin <= 0 && event.operatorUid) {
      const uin = this.deps.identity.findUinByUid(event.operatorUid, event.groupId);
      if (uin !== null) event.operatorUin = uin;
    }
  }

  private isSelfMemberIdentity(uin: number, uid?: string): boolean {
    const selfUin = Number(this.deps.identity.uin);
    return (uin > 0 && uin === selfUin) || (Boolean(uid) && uid === this.deps.identity.selfUid);
  }

  private handleSideEffects(event: QQEventVariant, alreadyRefreshed = false): void {
    this.rememberEventIdentity(event);
    if (alreadyRefreshed) return;

    let groupId = 0;
    let reason = '';
    let refreshGroupList = false;
    switch (event.kind) {
      case 'group_member_join':
        groupId = event.groupId;
        reason = 'group_member_join';
        refreshGroupList = this.isSelfMemberIdentity(event.userUin, event.userUid);
        break;
      case 'group_member_leave':
        groupId = event.groupId;
        reason = 'group_member_leave';
        break;
      case 'group_admin':
        groupId = event.groupId;
        reason = 'group_admin';
        break;
      default:
        return;
    }

    if (groupId <= 0) return;
    if (this.memberRefreshTasks_.has(groupId)) return;
    if (event.kind === 'group_member_join' && !this.deps.identity.findGroup(groupId)) {
      refreshGroupList = true;
    }

    const task = (async () => {
      try {
        await this.deps.refreshMemberCache(groupId, refreshGroupList, false);
        this.log.debug('member cache refreshed: group=%d reason=%s', groupId, reason);
      } catch (e) {
        this.log.warn('failed to refresh member cache: group=%d reason=%s err=%s',
          groupId, reason, e instanceof Error ? e.message : String(e));
      } finally {
        this.memberRefreshTasks_.delete(groupId);
      }
    })();

    this.memberRefreshTasks_.set(groupId, task);
  }

  private rememberEventIdentity(event: QQEventVariant): void {
    switch (event.kind) {
      case 'group_member_join':
        this.deps.identity.rememberGroupMemberIdentity(event.groupId, {
          uid: event.userUid,
          uin: event.userUin,
        });
        this.deps.identity.rememberGroupMemberIdentity(event.groupId, {
          uid: event.operatorUid,
          uin: event.operatorUin,
        });
        break;
      case 'group_member_leave':
        this.deps.identity.markGroupMemberInactive(event.groupId, {
          uid: event.userUid,
          uin: event.userUin,
        });
        this.deps.identity.rememberGroupMemberIdentity(event.groupId, {
          uid: event.operatorUid,
          uin: event.operatorUin,
        });
        break;
      case 'group_admin':
        this.deps.identity.rememberGroupMemberIdentity(event.groupId, {
          uin: event.userUin,
        });
        break;
      case 'friend_request':
        this.deps.identity.rememberRequestIdentity({
          uid: event.fromUid,
          uin: event.fromUin,
          source: 'friend_request',
        });
        break;
      case 'group_invite': {
        // Defensive: never cache a uid→uin mapping where uin equals
        // the group's own uin — that's the pollution signature the
        // legacy decoder fallback produced. Pass 0 so `rememberUidUin`
        // skips the map write (it short-circuits on uin <= 0) but the
        // user row still gets upserted with the uid + group context.
        const uinForCache = event.fromUin > 0 && event.fromUin !== event.groupId
          ? event.fromUin : 0;
        this.deps.identity.rememberRequestIdentity({
          groupId: event.groupId,
          uid: event.fromUid,
          uin: uinForCache,
          source: 'group_request',
        });
        break;
      }
      default:
        break;
    }
  }
}

function printEvent(log: Logger, identity: IdentityService, event: QQEventVariant): void {
  // Message-class events (group/friend/temp message) get rendered by the
  // OneBot layer's logReceivedMessage — its output already includes the
  // assigned message ID, which the raw packet doesn't have. Returning
  // null here is the formatter's signal to skip.
  const message = formatEvent(identity, event);
  if (!message) return;
  if (WARN_EVENT_KINDS.has(event.kind)) {
    log.warn('%s', message);
  } else {
    log.info('%s', message);
  }
}
