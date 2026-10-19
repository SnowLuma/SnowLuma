import type { PacketInfo } from '@snowluma/common/protocol-types';
import { formatEvent } from './format';
import { createLogger, type Logger } from '@snowluma/common/logger';
import type { BridgeEventBus } from './event-bus';
import type { QQEventVariant } from './events';
import type { IdentityService } from './identity-service';
import { formatGroupRequestFlag, type GroupRequestInfo } from './qq-info';

const moduleLog = createLogger('Bridge');
const moduleEventLog = createLogger('Event');
const modulePacketLog = createLogger('Protocol.Packet');

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

type GroupMemberIdentityEvent = Extract<
    QQEventVariant,
    { kind: 'group_member_join' | 'group_member_leave' }
>;

export type CmdParser = (pkt: PacketInfo, identity: IdentityService) => QQEventVariant[];

class EnrichedDispatchError extends Error {
    constructor(readonly originalError: unknown) {
        super(originalError instanceof Error ? originalError.message : String(originalError));
        this.name = 'EnrichedDispatchError';
    }
}

export interface PacketPipelineDeps {
    identity: IdentityService;
    events: BridgeEventBus;
    /** Account group-list fetch. Roster side-effect only; the pipeline
     *  swallows failures and does not read the returned roster. */
    fetchGroupList(): Promise<void>;
    /** One group's member-list fetch (adapter TTL applies). Roster
     *  side-effect only; the pipeline does not pass `force`. */
    fetchGroupMemberList(groupId: number): Promise<void>;
    /** Resolve a pending request's comment and approval tuple after a push. */
    resolveGroupJoinRequest(
        groupId: number,
        uid: string,
        subType: 'add' | 'invite',
        invitedUid?: string,
    ): Promise<GroupRequestInfo | null>;
    /** Remember a live card; false means its approval sequence was already seen. */
    rememberGroupInviteCardSequence(groupUin: number, sequence: number): boolean;
}

export class IncomingPacketPipeline {
    private cmdHandlers_ = new Map<string, CmdParser[]>();
    private memberRefreshTasks_ = new Map<number, Promise<void>>();
    private readonly log: Logger;
    private readonly eventLog: Logger;
    private readonly packetLog: Logger;

    constructor(private readonly deps: PacketPipelineDeps) {
        // Tag every line we emit with this Bridge's UIN so per-account file
        // routing works. Unparseable uin (shouldn't happen) falls back to
        // the module-level logger so we still log, just without the slot.
        const uinNum = Number.parseInt(deps.identity.uin, 10);
        const bind = Number.isFinite(uinNum) && uinNum > 0 ? { uin: uinNum } : null;
        this.log = bind ? moduleLog.child(bind) : moduleLog;
        this.eventLog = bind ? moduleEventLog.child(bind) : moduleEventLog;
        this.packetLog = bind ? modulePacketLog.child(bind) : modulePacketLog;
    }

    registerCmd(cmd: string, parser: CmdParser): void {
        const arr = this.cmdHandlers_.get(cmd) ?? [];
        arr.push(parser);
        this.cmdHandlers_.set(cmd, arr);
    }

    handlesCmd(cmd: string): boolean {
        return this.cmdHandlers_.has(cmd);
    }

    process(pkt: PacketInfo): Promise<void> {
        const startedAt = Date.now();
        const handlers = this.cmdHandlers_.get(pkt.serviceCmd);

        if (!handlers) {
            this.packetLog.trace(() => [
                'packet_branch serviceCmd=%j seqId=%d branch=parser_unregistered',
                pkt.serviceCmd,
                pkt.seqId,
            ]);
            this.packetLog.trace(() => [
                'packet_terminal serviceCmd=%j seqId=%d outcome=dropped reason=parser_unregistered events=0 dispatched=0 elapsedMs=%d',
                pkt.serviceCmd,
                pkt.seqId,
                Date.now() - startedAt,
            ]);
            return Promise.resolve();
        }

        let eventCount = 0;
        let dispatched = 0;
        let parserErrors = 0;
        let dispatchErrors = 0;
        let enrichmentFailures = 0;
        const enrichmentTasks: Promise<void>[] = [];

        handlers.forEach((handler, index) => {
            const parser = index + 1;

            try {
                const events = handler(pkt, this.deps.identity);

                if (events.length === 0) {
                    this.packetLog.trace(() => [
                        'packet_branch serviceCmd=%j seqId=%d parser=%d branch=parser_zero_events',
                        pkt.serviceCmd,
                        pkt.seqId,
                        parser,
                    ]);
                    return;
                }

                eventCount += events.length;
                this.packetLog.trace(() => [
                    'packet_branch serviceCmd=%j seqId=%d parser=%d branch=parser_events events=%d',
                    pkt.serviceCmd,
                    pkt.seqId,
                    parser,
                    events.length,
                ]);

                for (const event of events) {
                    if (this.needsPreDispatchIdentityRefresh(event)) {
                        this.traceEnrichmentStarted(pkt, event, 'identity_refresh');
                        const task = this.dispatchAfterIdentityRefresh(pkt, event)
                            .then((count) => {
                                dispatched += count;
                            })
                            .catch((error) => {
                                if (error instanceof EnrichedDispatchError) {
                                    dispatchErrors += 1;
                                    this.traceDispatchFailure(pkt, event, error.originalError);
                                } else {
                                    enrichmentFailures += 1;
                                    this.traceEnrichmentFailure(
                                        pkt,
                                        event,
                                        'identity_refresh',
                                        error,
                                    );
                                }

                                this.log.warn(
                                    'dispatchAfterIdentityRefresh failed: %s',
                                    error instanceof Error
                                        ? (error.stack ?? error.message)
                                        : String(error),
                                );
                            });
                        enrichmentTasks.push(task);
                    } else if (event.kind === 'group_invite') {
                        this.traceEnrichmentStarted(pkt, event, 'group_invite');
                        const task = this.dispatchGroupInvite(pkt, event)
                            .then((count) => {
                                dispatched += count;
                            })
                            .catch((error) => {
                                if (error instanceof EnrichedDispatchError) {
                                    dispatchErrors += 1;
                                    this.traceDispatchFailure(pkt, event, error.originalError);
                                } else {
                                    enrichmentFailures += 1;
                                    this.traceEnrichmentFailure(pkt, event, 'group_invite', error);
                                }

                                this.log.warn(
                                    'dispatchGroupInvite failed: %s',
                                    error instanceof Error
                                        ? (error.stack ?? error.message)
                                        : String(error),
                                );
                            });
                        enrichmentTasks.push(task);
                    } else {
                        try {
                            dispatched += this.dispatchEvent(pkt, event, 'sync');
                        } catch (error) {
                            dispatchErrors += 1;
                            this.traceDispatchFailure(pkt, event, error);
                            this.log.error(
                                'dispatch error for %s event=%s: %s',
                                pkt.serviceCmd,
                                event.kind,
                                error instanceof Error
                                    ? (error.stack ?? error.message)
                                    : String(error),
                            );
                            break;
                        }
                    }
                }
            } catch (error) {
                parserErrors += 1;
                this.packetLog.trace(() => [
                    'packet_branch serviceCmd=%j seqId=%d parser=%d branch=parser_exception error=%j',
                    pkt.serviceCmd,
                    pkt.seqId,
                    parser,
                    error instanceof Error ? error.message : String(error),
                ]);
                this.log.error(
                    'handler error for %s: %s',
                    pkt.serviceCmd,
                    error instanceof Error ? (error.stack ?? error.message) : String(error),
                );
            }
        });

        const finish = (): void => {
            if (enrichmentFailures > 0 || dispatchErrors > 0) {
                this.packetLog.trace(() => [
                    'packet_terminal serviceCmd=%j seqId=%d outcome=failed reason=%s events=%d dispatched=%d parserErrors=%d dispatchErrors=%d elapsedMs=%d',
                    pkt.serviceCmd,
                    pkt.seqId,
                    enrichmentFailures > 0 ? 'enrichment_failed' : 'dispatch_exception',
                    eventCount,
                    dispatched,
                    parserErrors,
                    dispatchErrors,
                    Date.now() - startedAt,
                ]);
                return;
            }

            if (parserErrors > 0) {
                this.packetLog.trace(() => [
                    'packet_terminal serviceCmd=%j seqId=%d outcome=failed reason=parser_exception events=%d dispatched=%d parserErrors=%d elapsedMs=%d',
                    pkt.serviceCmd,
                    pkt.seqId,
                    eventCount,
                    dispatched,
                    parserErrors,
                    Date.now() - startedAt,
                ]);
                return;
            }

            if (dispatched > 0) {
                this.packetLog.trace(() => [
                    'packet_terminal serviceCmd=%j seqId=%d outcome=completed reason=dispatch_complete events=%d dispatched=%d parserErrors=%d elapsedMs=%d',
                    pkt.serviceCmd,
                    pkt.seqId,
                    eventCount,
                    dispatched,
                    parserErrors,
                    Date.now() - startedAt,
                ]);
                return;
            }

            this.packetLog.trace(() => [
                'packet_terminal serviceCmd=%j seqId=%d outcome=%s reason=%s events=%d dispatched=0 parserErrors=%d elapsedMs=%d',
                pkt.serviceCmd,
                pkt.seqId,
                parserErrors > 0 ? 'failed' : 'dropped',
                parserErrors > 0 ? 'parser_exception' : 'no_events',
                eventCount,
                parserErrors,
                Date.now() - startedAt,
            ]);
        };

        if (enrichmentTasks.length === 0) {
            finish();
            return Promise.resolve();
        }

        return Promise.all(enrichmentTasks).then(finish);
    }

    private traceEnrichmentStarted(
        pkt: PacketInfo,
        event: QQEventVariant,
        enrichment: 'identity_refresh' | 'group_invite',
    ): void {
        this.packetLog.trace(() => [
            'packet_branch serviceCmd=%j seqId=%d branch=enrichment_started eventKind=%j enrichment=%j',
            pkt.serviceCmd,
            pkt.seqId,
            event.kind,
            enrichment,
        ]);
    }

    private traceEnrichmentFailure(
        pkt: PacketInfo,
        event: QQEventVariant,
        enrichment: 'identity_refresh' | 'group_invite',
        error: unknown,
    ): void {
        this.packetLog.trace(() => [
            'packet_branch serviceCmd=%j seqId=%d branch=enrichment_failed eventKind=%j enrichment=%j error=%j',
            pkt.serviceCmd,
            pkt.seqId,
            event.kind,
            enrichment,
            error instanceof Error ? error.message : String(error),
        ]);
    }

    private traceDispatchFailure(pkt: PacketInfo, event: QQEventVariant, error: unknown): void {
        this.packetLog.trace(() => [
            'packet_branch serviceCmd=%j seqId=%d branch=dispatch_exception eventKind=%j error=%j',
            pkt.serviceCmd,
            pkt.seqId,
            event.kind,
            error instanceof Error ? error.message : String(error),
        ]);
    }

    private traceDispatch(
        pkt: PacketInfo,
        eventKind: QQEventVariant['kind'],
        mode: 'sync' | 'enriched' | 'derived',
    ): void {
        this.packetLog.trace(() => [
            'packet_branch serviceCmd=%j seqId=%d branch=dispatch eventKind=%j mode=%s',
            pkt.serviceCmd,
            pkt.seqId,
            eventKind,
            mode,
        ]);
    }

    private dispatchEvent(
        pkt: PacketInfo,
        event: QQEventVariant,
        mode: 'sync' | 'enriched',
    ): number {
        // Snapshot the sender's cached group card BEFORE dispatch — the side-effects
        // inside finishDispatch self-heal it, so the old value must be read first.
        const cardBefore = this.groupCardBefore(event);
        this.finishDispatch(event);
        this.traceDispatch(pkt, event.kind, mode);

        let dispatched = 1;

        if (this.emitGroupCardChange(event, cardBefore)) {
            this.traceDispatch(pkt, 'group_card_change', 'derived');
            dispatched++;
        }

        if (this.emitGroupInviteCard(event)) {
            this.traceDispatch(pkt, 'group_invite', 'derived');
            dispatched++;
        }

        return dispatched;
    }

    private emitGroupInviteCard(event: QQEventVariant): boolean {
        if (event.kind !== 'friend_message' || event.senderUin === event.selfUin) {
            return false;
        }

        const groupId = event.inviteCardGroupUin;
        const sequence = event.inviteCardSequence;

        if (
            !groupId ||
            !sequence ||
            !this.deps.rememberGroupInviteCardSequence(groupId, sequence)
        ) {
            return false;
        }

        this.finishDispatch({
            kind: 'group_invite',
            time: event.time,
            selfUin: event.selfUin,
            groupId,
            fromUin: event.senderUin,
            fromUid: event.senderUid,
            invitedUin: event.selfUin,
            subType: 'invite',
            message: '',
            flag: formatGroupRequestFlag({ groupId, sequence, eventType: 2, filtered: false }),
        });
        return true;
    }

    private emit(event: QQEventVariant): void {
        // Fire-and-forget: errors inside subscribers are surfaced via the bus's
        // own onError hook so one bad listener never blocks the others.
        void this.deps.events.emit(event);
    }

    /** The sender's cached group card just before this event is dispatched (its
     *  side-effects will overwrite the cache). Only meaningful for group_message. */
    private groupCardBefore(event: QQEventVariant): string | undefined {
        if (event.kind !== 'group_message') {
            return undefined;
        }

        return this.deps.identity.findGroupMember(event.groupId, event.senderUin)?.card;
    }

    /** Surface a `group_card_change` when a KNOWN member's card actually changed —
     *  mirrors NapCat's `parseCardChangedEvent`. Requires a non-empty prior card
     *  (`cardBefore`) that differs from a non-empty new one, so a cold/unknown
     *  cache never fabricates a change on first contact. */
    private emitGroupCardChange(event: QQEventVariant, cardBefore: string | undefined): boolean {
        if (event.kind !== 'group_message') {
            return false;
        }

        const cardNew = event.senderCard ?? '';

        if (!cardBefore || !cardNew || cardBefore === cardNew) {
            return false;
        }

        this.finishDispatch({
            kind: 'group_card_change',
            time: event.time,
            selfUin: event.selfUin,
            groupId: event.groupId,
            userUin: event.senderUin,
            cardNew,
            cardOld: cardBefore,
        });
        return true;
    }

    /**
     * Common dispatch tail shared by the sync path and the two async enrichment
     * paths: run side effects, log the event, then emit it.
     */
    private finishDispatch(event: QQEventVariant): void {
        this.handleSideEffects(event);
        printEvent(this.eventLog, this.deps.identity, event);
        this.emit(event);
    }

    private needsPreDispatchIdentityRefresh(
        event: QQEventVariant,
    ): event is Extract<QQEventVariant, { kind: 'group_member_join' }> {
        return (
            event.kind === 'group_member_join' &&
            event.groupId > 0 &&
            event.userUin <= 0 &&
            Boolean(event.userUid)
        );
    }

    private async dispatchAfterIdentityRefresh(
        pkt: PacketInfo,
        event: Extract<QQEventVariant, { kind: 'group_member_join' }>,
    ): Promise<number> {
        try {
            await this.prepareGroupMemberJoinIdentity(event);
        } catch (e) {
            this.packetLog.trace(() => [
                'packet_branch serviceCmd=%j seqId=%d branch=enrichment_degraded eventKind=%j enrichment="identity_refresh" error=%j',
                pkt.serviceCmd,
                pkt.seqId,
                event.kind,
                e instanceof Error ? e.message : String(e),
            ]);
            this.log.warn(
                'failed to resolve group member join identity: group=%d uid=%s err=%s',
                event.groupId,
                event.userUid ?? '',
                e instanceof Error ? e.message : String(e),
            );
        }

        try {
            return this.dispatchEvent(pkt, event, 'enriched');
        } catch (error) {
            throw new EnrichedDispatchError(error);
        }
    }

    private async dispatchGroupInvite(
        pkt: PacketInfo,
        event: Extract<QQEventVariant, { kind: 'group_invite' }>,
    ): Promise<number> {
        // Self-invite notices omit the approval msgseq; the private card owns this event.
        if (
            event.subType === 'invite' &&
            this.isSelfMemberIdentity(event.invitedUin ?? 0, event.invitedUid)
        ) {
            return 0;
        }

        const uid = event.fromUid;

        if (!uid) {
            throw new Error('group request omitted requester UID');
        }

        this.deps.identity.rememberRequestIdentity({
            groupId: event.groupId,
            uid,
            uin: event.fromUin,
            source: 'group_request',
        });
        const request = await this.deps.resolveGroupJoinRequest(
            event.groupId,
            uid,
            event.subType,
            event.invitedUid,
        );

        if (!request) {
            this.log.warn('pending group request not found: group=%d uid=%s', event.groupId, uid);
            return 0;
        }

        if (request.eventType === 2) {
            return 0;
        }

        event.message = request.comment;
        event.flag = formatGroupRequestFlag(request);
        const requesterUin = event.subType === 'invite' ? request.invitorUin : request.targetUin;
        event.fromUin =
            event.fromUin ||
            requesterUin ||
            (await this.deps.identity.resolveUin(uid, event.groupId)) ||
            0;

        if (event.fromUin === 0) {
            this.log.warn('group request sender unavailable: group=%d uid=%s', event.groupId, uid);
        }

        if (event.subType === 'invite') {
            event.invitedUid = request.targetUid;
            event.invitedUin =
                request.targetUin ||
                (await this.deps.identity.resolveUin(request.targetUid, event.groupId)) ||
                0;
        }

        try {
            return this.dispatchEvent(pkt, event, 'enriched');
        } catch (error) {
            throw new EnrichedDispatchError(error);
        }
    }

    private async prepareGroupMemberJoinIdentity(
        event: Extract<QQEventVariant, { kind: 'group_member_join' }>,
    ): Promise<void> {
        this.resolveMemberIdentityFromCache(event);

        if (event.userUin > 0 || !event.userUid) {
            return;
        }

        const uin = await this.deps.identity.resolveUin(event.userUid, event.groupId);

        if (uin !== null) {
            event.userUin = uin;
        }

        this.resolveMemberIdentityFromCache(event);
    }

    private resolveMemberIdentityFromCache(event: GroupMemberIdentityEvent): void {
        if (event.groupId <= 0) {
            return;
        }

        if (event.userUin <= 0 && event.userUid) {
            const uin = this.deps.identity.findUinByUid(event.userUid, event.groupId);

            if (uin !== null) {
                event.userUin = uin;
            }
        }

        if (event.operatorUin <= 0 && event.operatorUid) {
            const uin = this.deps.identity.findUinByUid(event.operatorUid, event.groupId);

            if (uin !== null) {
                event.operatorUin = uin;
            }
        }
    }

    private isSelfMemberIdentity(uin: number, uid?: string): boolean {
        const selfUin = Number(this.deps.identity.uin);
        return (uin > 0 && uin === selfUin) || (Boolean(uid) && uid === this.deps.identity.selfUid);
    }

    private handleSideEffects(event: QQEventVariant): void {
        this.rememberEventIdentity(event);

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

        if (groupId <= 0) {
            return;
        }

        if (this.memberRefreshTasks_.has(groupId)) {
            return;
        }

        if (event.kind === 'group_member_join' && !this.deps.identity.findGroup(groupId)) {
            refreshGroupList = true;
        }

        const task = (async () => {
            try {
                if (refreshGroupList) {
                    try {
                        await this.deps.fetchGroupList();
                    } catch {
                        /* ignore */
                    }
                }

                if (!this.deps.identity.findGroup(groupId)) {
                    this.log.debug('member cache refreshed: group=%d reason=%s', groupId, reason);
                    return;
                }

                await this.deps.fetchGroupMemberList(groupId);
                this.log.debug('member cache refreshed: group=%d reason=%s', groupId, reason);
            } catch (e) {
                this.log.warn(
                    'failed to refresh member cache: group=%d reason=%s err=%s',
                    groupId,
                    reason,
                    e instanceof Error ? e.message : String(e),
                );
            } finally {
                this.memberRefreshTasks_.delete(groupId);
            }
        })();

        this.memberRefreshTasks_.set(groupId, task);
    }

    private rememberEventIdentity(event: QQEventVariant): void {
        switch (event.kind) {
            case 'friend_message':
                // The message already carries the authoritative UID/UIN pair. Keep it
                // at the receive boundary so later C2C operations never have to infer
                // a peer UID from a stale message row or a fallible profile lookup.
                this.deps.identity.rememberRequestIdentity({
                    uid: event.senderUid,
                    uin: event.senderUin,
                    source: 'friend_message',
                });

                break;

            case 'group_message': {
                // [#1] Self-heal a member's cached group card from message traffic. The
                // member cache only refreshes via a member-list refetch, which nothing
                // triggers on a card change and a quiet, months-long bot may never fire.
                // The decoder resolved the current card from field 4 into senderCard;
                // when it differs from the cache, update it — gated so we write only on
                // an actual change, not on every message.
                const cached = this.deps.identity.findGroupMember(event.groupId, event.senderUin);

                if (cached && event.senderCard && event.senderCard !== cached.card) {
                    this.deps.identity.updateGroupMember(event.groupId, {
                        ...cached,
                        card: event.senderCard,
                    });
                }

                break;
            }

            case 'group_member_join':
                this.deps.identity.rememberGroupMemberIdentity(event.groupId, {
                    uid: event.userUid,
                    uin: event.userUin,
                });
                this.deps.identity.rememberGroupMemberIdentity(event.groupId, {
                    uid: event.operatorUid,
                    uin: event.operatorUin,
                });
                this.deps.identity.rememberGroupMemberJoined(event.groupId, {
                    uid: event.userUid,
                    uin: event.userUin,
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

            case 'group_admin': {
                this.deps.identity.rememberGroupMemberIdentity(event.groupId, {
                    uin: event.userUin,
                });
                // #93: get_group_member_info serves the cache and must not refetch
                // per message. Patch a known member's role here — never invent a
                // phantom, never downgrade the owner.
                const cached = this.deps.identity.findGroupMember(event.groupId, event.userUin);

                if (cached && cached.role !== 'owner') {
                    this.deps.identity.updateGroupMember(event.groupId, {
                        ...cached,
                        role: event.set ? 'admin' : 'member',
                    });
                }

                break;
            }

            case 'friend_request':
                this.deps.identity.rememberRequestIdentity({
                    uid: event.fromUid,
                    uin: event.fromUin,
                    source: 'friend_request',
                });
                break;

            case 'friend_remark_changed': {
                const rosterUpdated = this.deps.identity.updateFriendRemark(
                    event.userUid,
                    event.userUin,
                    event.remark,
                );
                this.log.debug(
                    'friend remark synchronized (uid=%s uin=%d length=%d rosterUpdated=%s)',
                    event.userUid,
                    event.userUin,
                    event.remark.length,
                    rosterUpdated,
                );
                break;
            }

            case 'group_invite': {
                this.deps.identity.rememberRequestIdentity({
                    groupId: event.groupId,
                    uid: event.fromUid,
                    uin: event.fromUin,
                    source: 'group_request',
                });

                if (event.invitedUid) {
                    this.deps.identity.rememberRequestIdentity({
                        groupId: event.groupId,
                        uid: event.invitedUid,
                        uin: event.invitedUin ?? 0,
                        source: 'group_request',
                    });
                }

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

    if (!message) {
        return;
    }

    if (WARN_EVENT_KINDS.has(event.kind)) {
        log.warn('%s', message);
    } else {
        log.info('%s', message);
    }
}
