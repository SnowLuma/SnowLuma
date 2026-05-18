// Incoming packet pipeline — the chain that turns a single PacketInfo
// arriving from the hook layer into a stream of QQEventVariant
// emissions on the typed event bus. Replaces the inline orchestration
// that previously lived on Bridge.onPacket / triggerMemberCacheRefresh /
// rememberEventIdentity / dispatchAfterIdentityRefresh / etc.
//
// Stage chain per parser output:
//   parse  →  enrich identity (sync, or async refresh)
//          →  side-effects (remember UID/UIN + schedule roster refresh)
//          →  log
//          →  emit on bus
//
// The pipeline owns its cmd handler map and its per-group coalesce table
// for background member-list refreshes. It does NOT own protocol calls
// — `refreshMemberCache` is injected by Bridge because it ultimately
// dispatches OIDB packets through Bridge.fetchGroupList /
// Bridge.fetchGroupMemberList.

import type { PacketInfo } from '../protocol/types';
import type { QQEventVariant } from './events';
import type { IdentityService } from './identity-service';
import type { BridgeEventBus } from './event-bus';
import { createLogger, type Logger } from '../utils/logger';
import { formatEvent } from '../utils/event-format';

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
      case 'group_invite':
        this.deps.identity.rememberRequestIdentity({
          groupId: event.groupId,
          uid: event.fromUid,
          uin: event.fromUin,
          source: 'group_request',
        });
        break;
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
