import { createLogger, renderTraceBytes, runWithTraceRequest } from '@snowluma/common/logger';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import { packetTimeoutMs } from '@snowluma/bridge/packet-timeout';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MSG_PUSH_CMD, parseMsgPushOrThrow, SysMsgDedup } from '@snowluma/protocol/msg-push';
import { KICK_NT_CMD, parseKickNT } from '@snowluma/protocol/kick-nt';
import { IncomingPacketPipeline, type CmdParser } from '@snowluma/protocol/packet-pipeline';
import type { OnlineDeviceInfo } from '@snowluma/protocol/events';
import { buildApiHub, type ApiHub } from './apis';
import { AiVoiceChatType, type AiVoiceCategory, type StrangerStatus } from './apis/extras';
import type { BridgeInterface, RosterWarmupResult } from './bridge-interface';

const log = createLogger('Bridge');
const runtimeLog = createLogger('Bridge.Runtime');
const VERBOSE_WARMUP = process.env.SNOWLUMA_VERBOSE_WARMUP === '1';

interface ProcessConnection {
    pid: number;
    client: PacketSender;
    receiveHealthy: boolean;
}

export class Bridge implements BridgeInterface {
    readonly identity: IdentityService;
    /** Insertion order tracks login recency; the newest connection sends packets. */
    private readonly connections = new Map<number, ProcessConnection>();
    readonly events = new BridgeEventBus();
    readonly apis: ApiHub;
    private readonly pipeline: IncomingPacketPipeline;
    private static readonly UPLOADED_FILE_CACHE_MAX = 1024;
    private uploadedFileMeta_ = new Map<string, UploadedFileMeta>();
    private clientSeq_ = 100000000 + (Date.now() % 1000000000);
    private msgRandom_ = (Date.now() & 0xffffffff) >>> 0;
    // Per-account dedup for QQ NT's already-deduped system pushes (#137).
    private readonly sysMsgDedup_ = new SysMsgDedup();
    private onlineClients_: readonly Readonly<OnlineDeviceInfo>[] | null = null;
    private disposePromise_: Promise<void> | null = null;
    private readonly pendingPackets_ = new Set<Promise<void>>();
    private rosterWarmupStarted_ = false;
    private settleRosterWarmup!: (result: RosterWarmupResult) => void;
    private readonly rosterWarmup = new Promise<RosterWarmupResult>((resolve) => {
        this.settleRosterWarmup = resolve;
    });

    constructor(identity: IdentityService) {
        this.identity = identity;
        this.apis = buildApiHub(this);
        this.identity.setFetcher({
            fetchProfile: (uin) => this.apis.contacts.fetchUserProfile(uin),
            fetchProfileByUid: (uid) => this.apis.contacts.fetchUserProfileByUid(uid),
            fetchGroupMemberList: (gid) => this.apis.contacts.fetchGroupMemberList(gid),
        });
        this.pipeline = new IncomingPacketPipeline({
            identity: this.identity,
            events: this.events,
            fetchGroupList: async () => {
                await this.apis.contacts.fetchGroupList();
            },
            fetchGroupMemberList: async (groupId) => {
                await this.apis.contacts.fetchGroupMemberList(groupId);
            },
            resolveGroupJoinRequest: (groupId, uid, subType, invitedUid) =>
                this.apis.contacts.resolveGroupJoinRequest(groupId, uid, subType, invitedUid),
            rememberGroupInviteCardSequence: (groupUin, sequence) =>
                this.apis.contacts.rememberGroupInviteCardSequence(groupUin, sequence),
        });
        this.pipeline.registerCmd(MSG_PUSH_CMD, (pkt, identity) =>
            parseMsgPushOrThrow(pkt, identity, this.sysMsgDedup_),
        );
        this.pipeline.registerCmd(KICK_NT_CMD, parseKickNT);
        this.events.on('online_devices_changed', (event) => {
            const snapshot = event.devices.map((device) => Object.freeze({ ...device }));
            this.onlineClients_ = Object.freeze(snapshot);
            log.debug(
                'online-device snapshot updated: uin=%s clients=%d types=%s',
                this.identity.uin,
                snapshot.length,
                snapshot.map((device) => device.clientType).join(','),
            );
        });
    }

    dispose(): Promise<void> {
        if (this.disposePromise_) {
            return this.disposePromise_;
        }

        this.settleRosterWarmup({ friendsLoaded: false, groupsLoaded: false });
        this.connections.clear();
        this.onlineClients_ = null;
        this.disposePromise_ = (async () => {
            try {
                await Promise.allSettled(this.pendingPackets_);
                await this.identity.close();
            } finally {
                this.events.clear();
            }
        })();
        return this.disposePromise_;
    }

    registerCmd(cmd: string, parser: CmdParser): void {
        this.pipeline.registerCmd(cmd, parser);
    }

    handlesCmd(cmd: string): boolean {
        return this.pipeline.handlesCmd(cmd);
    }

    bindPid(pid: number, client: PacketSender): void {
        const previous = this.activeConnection;
        this.connections.delete(pid);
        // A new login stays healthy until the watchdog confirms a failure.
        this.connections.set(pid, { pid, client, receiveHealthy: true });

        if (previous?.pid !== pid || previous.client !== client) {
            runtimeLog.trace(
                'bridge_sender_fact event=selected uin=%j pid=%d previousPid=%j',
                this.identity.uin,
                pid,
                previous?.pid ?? null,
            );
        }

        this.maybeStartRosterWarmup();
    }

    /** @internal BridgeManager lookup used when an incoming packet is the first
     *  observation that a live PID changed UIN. */
    packetClientForPid(pid: number): PacketSender | null {
        return this.connections.get(pid)?.client ?? null;
    }

    detachPid(pid: number): void {
        const wasActive = this.activePid === pid;
        this.connections.delete(pid);
        const active = this.activeConnection;

        if (wasActive && active) {
            runtimeLog.trace(
                'bridge_sender_fact event=fallback uin=%j detachedPid=%d fallbackPid=%d',
                this.identity.uin,
                pid,
                active.pid,
            );
            log.debug(
                'packet sender changed: UIN=%s PID=%d→%d',
                this.identity.uin,
                pid,
                active.pid,
            );
        }
    }
    hasPid(pid: number): boolean {
        return this.connections.has(pid);
    }
    get empty(): boolean {
        return this.connections.size === 0;
    }
    private get activeConnection(): ProcessConnection | undefined {
        return [...this.connections.values()].at(-1);
    }
    get activePid(): number | null {
        return this.activeConnection?.pid ?? null;
    }
    get receiveHealthy(): boolean {
        return [...this.connections.values()].some((connection) => connection.receiveHealthy);
    }
    setPidReceiveHealthy(pid: number, healthy: boolean): void {
        const connection = this.connections.get(pid);

        if (!connection) {
            throw new Error(`Bridge receive-health invariant violated: PID=${pid} is not attached`);
        }

        connection.receiveHealthy = healthy;
    }
    getOnlineClients(): readonly Readonly<OnlineDeviceInfo>[] | null {
        return this.onlineClients_;
    }

    whenRosterWarmupSettled(): Promise<RosterWarmupResult> {
        return this.rosterWarmup;
    }

    onPacket(pkt: PacketInfo): Promise<void> {
        if (this.disposePromise_) {
            return Promise.reject(new Error('Bridge is disposed'));
        }

        const work = this.identity.initialization.then(() => this.pipeline.process(pkt));
        this.pendingPackets_.add(work);
        void work.finally(() => this.pendingPackets_.delete(work)).catch(() => undefined);
        return work;
    }

    rememberUploadedFile(meta: UploadedFileMeta): void {
        if (!meta.fileId) {
            return;
        }

        if (this.uploadedFileMeta_.size >= Bridge.UPLOADED_FILE_CACHE_MAX) {
            // Map iteration order is insertion order — drop the oldest.
            const oldest = this.uploadedFileMeta_.keys().next().value;

            if (oldest !== undefined) {
                this.uploadedFileMeta_.delete(oldest);
            }
        }

        this.uploadedFileMeta_.set(meta.fileId, meta);
    }

    recallUploadedFile(fileId: string): UploadedFileMeta | undefined {
        if (!fileId) {
            return undefined;
        }

        return this.uploadedFileMeta_.get(fileId);
    }

    nextClientSequence(): number {
        return ++this.clientSeq_;
    }

    nextMessageRandom(): number {
        this.msgRandom_ = (this.msgRandom_ + 0x9e3779b9) >>> 0;
        return this.msgRandom_ & 0x7fffffff;
    }
    async sendRawPacket(
        serviceCmd: string,
        body: Uint8Array,
        timeoutMs = packetTimeoutMs(),
    ): Promise<SendPacketResult> {
        const connection = this.activeConnection;

        if (!connection) {
            return runWithTraceRequest(() => {
                const startedAt = Date.now();
                runtimeLog.trace(() => [
                    'bridge_send_start serviceCmd=%j uin=%j activePid=%j timeoutMs=%d length=%d body=%s',
                    serviceCmd,
                    this.identity.uin,
                    this.activePid,
                    timeoutMs,
                    body.byteLength,
                    renderTraceBytes(body),
                ]);
                log.warn('packet %s dropped: no packet sender attached', serviceCmd);
                runtimeLog.trace(() => [
                    'bridge_send_terminal serviceCmd=%j uin=%j activePid=%j outcome=dropped reason=no_sender length=%d body=%s elapsedMs=%d',
                    serviceCmd,
                    this.identity.uin,
                    this.activePid,
                    body.byteLength,
                    renderTraceBytes(body),
                    Date.now() - startedAt,
                ]);
                return {
                    success: false,
                    gotResponse: false,
                    errorCode: -1,
                    errorMessage: 'no packet sender attached',
                    responseData: null,
                };
            });
        }

        const startedAt = Date.now();
        const result = await connection.client.sendPacket(serviceCmd, Buffer.from(body), timeoutMs);
        const elapsed = Date.now() - startedAt;
        const respLen = result.responseData ? result.responseData.length : 0;

        if (!result.success || result.errorCode !== 0) {
            // QQ-side rejection or transport failure — the usual root cause when an
            // action misbehaves. Warn (persisted) with cmd + code so a user's log
            // shows exactly where the chain broke.
            log.warn(
                'packet %s failed: code=%d gotResponse=%s %s (uin=%s, %dB, %dms)',
                serviceCmd,
                result.errorCode,
                result.gotResponse,
                result.errorMessage ?? '',
                this.identity.uin,
                body.length,
                elapsed,
            );
        } else {
            // Happy path — memory-only trace so the full chain shows under the
            // request's [req#N] when debugging, without flooding disk.
            log.trace(() => [
                `packet ${serviceCmd} ok (${body.length}B⇄${respLen}B, ${elapsed}ms)`,
            ]);
        }

        return result;
    }

    async resolveUserUid(uin: number, groupId?: number): Promise<string> {
        return this.identity.resolveUid(uin, groupId);
    }

    private maybeStartRosterWarmup(): void {
        if (this.disposePromise_ || this.rosterWarmupStarted_ || this.empty) {
            return;
        }

        this.rosterWarmupStarted_ = true;

        if (!this.identity.nickname) {
            this.identity.nickname = this.identity.uin;
        }

        void this.runRosterWarmup().then(
            (result) =>
                this.settleRosterWarmup(
                    this.disposePromise_ ? { friendsLoaded: false, groupsLoaded: false } : result,
                ),
            (err) => {
                log.warn(
                    'roster warmup failed: uin=%s err=%s',
                    this.identity.uin,
                    err instanceof Error ? (err.stack ?? err.message) : String(err),
                );
                this.settleRosterWarmup({ friendsLoaded: false, groupsLoaded: false });
            },
        );
    }

    private stillOpen(): boolean {
        return this.disposePromise_ === null;
    }

    private async runRosterWarmup(): Promise<RosterWarmupResult> {
        await this.identity.initialization;

        if (this.disposePromise_) {
            return { friendsLoaded: false, groupsLoaded: false };
        }

        const uin = this.identity.uin;
        const selfUin = parseInt(uin, 10) || 0;
        let selfResolved = false;
        let friendsLoaded = false;

        try {
            const friends = await this.apis.contacts.fetchFriendList();

            if (!this.stillOpen()) {
                return { friendsLoaded: false, groupsLoaded: false };
            }

            friendsLoaded = true;
            log.info('friends loaded: UIN=%s count=%d', uin, friends.length);

            for (const friend of friends) {
                if (friend.uin === selfUin) {
                    this.identity.setSelfProfile({
                        uin: friend.uin,
                        uid: friend.uid,
                        nickname: friend.nickname || uin,
                        remark: '',
                        qid: '',
                        sex: 'unknown',
                        age: 0,
                        sign: '',
                        avatar: '',
                        level: 0,
                        qidianMasterFlag: 0,
                        qidianCrewFlag: 0,
                        qidianCrewFlag2: 0,
                    });
                    this.identity.nickname = friend.nickname || uin;
                    log.debug(
                        'self info: UIN=%s uid=%s nickname=%s',
                        uin,
                        friend.uid,
                        friend.nickname ?? '',
                    );
                    selfResolved = true;
                    break;
                }
            }
        } catch (e) {
            if (!this.stillOpen()) {
                return { friendsLoaded: false, groupsLoaded: false };
            }

            log.warn(
                'failed to load friends for UIN %s: %s',
                uin,
                e instanceof Error ? e.message : String(e),
            );
        }

        if (!selfResolved && selfUin > 0 && this.stillOpen()) {
            try {
                const profile = await this.apis.contacts.fetchUserProfile(selfUin);

                if (!this.stillOpen()) {
                    return { friendsLoaded: false, groupsLoaded: false };
                }

                this.identity.setSelfProfile(profile);
                this.identity.nickname = profile.nickname || uin;
                log.debug(
                    'self info via profile: UIN=%s uid=%s nickname=%s',
                    uin,
                    profile.uid,
                    profile.nickname,
                );
            } catch (e) {
                if (!this.stillOpen()) {
                    return { friendsLoaded: false, groupsLoaded: false };
                }

                log.warn(
                    'failed to load self profile for UIN %s: %s',
                    uin,
                    e instanceof Error ? e.message : String(e),
                );
            }
        }

        let groups: { groupId: number }[] = [];
        let groupsLoaded = false;

        try {
            groups = await this.apis.contacts.fetchGroupList();

            if (!this.stillOpen()) {
                return { friendsLoaded: false, groupsLoaded: false };
            }

            groupsLoaded = true;
            log.info('groups loaded: UIN=%s count=%d', uin, groups.length);
        } catch (e) {
            if (!this.stillOpen()) {
                return { friendsLoaded: false, groupsLoaded: false };
            }

            log.warn(
                'failed to load groups for UIN %s: %s',
                uin,
                e instanceof Error ? e.message : String(e),
            );
        }

        let loadedGroupCount = 0;
        let loadedMemberCount = 0;
        let failedGroupCount = 0;

        for (const group of groups) {
            if (!this.stillOpen()) {
                return { friendsLoaded: false, groupsLoaded: false };
            }

            try {
                const members = await this.apis.contacts.fetchGroupMemberList(group.groupId);

                if (!this.stillOpen()) {
                    return { friendsLoaded: false, groupsLoaded: false };
                }

                loadedGroupCount += 1;
                loadedMemberCount += members.length;

                if (VERBOSE_WARMUP) {
                    log.debug('members loaded: group=%d count=%d', group.groupId, members.length);
                }
            } catch (e) {
                if (!this.stillOpen()) {
                    return { friendsLoaded: false, groupsLoaded: false };
                }

                failedGroupCount += 1;
                log.warn(
                    'failed to load members for group %d: %s',
                    group.groupId,
                    e instanceof Error ? e.message : String(e),
                );
            }
        }

        if (!this.stillOpen()) {
            return { friendsLoaded: false, groupsLoaded: false };
        }

        log.info(
            'member warmup completed: UIN=%s groups=%d/%d members=%d failed=%d',
            uin,
            loadedGroupCount,
            groups.length,
            loadedMemberCount,
            failedGroupCount,
        );
        return { friendsLoaded, groupsLoaded };
    }
}
export interface SendMessageReceipt {
    messageId: number;
    sequence: number;
    clientSequence: number;
    random: number;
    timestamp: number;
}

export interface UploadedFileMeta {
    fileId: string;
    scope: 'group' | 'private';
    /** Group id if scope='group', else `undefined`. */
    groupId?: number;
    /** Friend uin if scope='private', else `undefined`. */
    userId?: number;
    fileName: string;
    fileSize: number;
    fileMd5: Uint8Array;
    fileSha1: Uint8Array;
    /** Server-issued hash returned alongside the upload (private only). */
    fileHash?: string;
    /** Insert time — used to evict the oldest entry when the cache fills. */
    rememberedAt: number;
}

export interface DownloadRKeyInfo {
    rkey: string;
    ttlSeconds: number;
    storeId: number;
    createTime: number;
    type: number;
}

export interface ClientKeyInfo {
    clientKey: string;
    expireTime: string;
    keyIndex: string;
}
export { AiVoiceChatType };
export type { AiVoiceCategory, StrangerStatus };
