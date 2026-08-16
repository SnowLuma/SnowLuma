import {
  createLogger,
  renderTraceBytes,
  runWithTraceRequest,
} from '@snowluma/common/logger';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import {
  MSG_PUSH_CMD,
  parseMsgPushOrThrow,
  SysMsgDedup,
} from '@snowluma/protocol/msg-push';
import { KICK_NT_CMD, parseKickNT } from '@snowluma/protocol/kick-nt';
import { IncomingPacketPipeline, type CmdParser } from '@snowluma/protocol/packet-pipeline';
import type { OnlineDeviceInfo } from '@snowluma/protocol/events';
import { buildApiHub, type ApiHub } from './apis';
import {
  AiVoiceChatType,
  type AiVoiceCategory,
  type StrangerStatus,
} from './apis/extras';
import type { BridgeInterface } from './bridge-interface';

const log = createLogger('Bridge');
const runtimeLog = createLogger('Bridge.Runtime');

export class Bridge implements BridgeInterface {
  readonly identity: IdentityService;
  private pids_ = new Set<number>();
  private readonly receiveHealthByPid_ = new Map<number, boolean>();
  /** Packet senders keyed by their owning QQ process. Keeping the sender and
   *  PID together is what makes disconnect fallback deterministic: a sender
   *  can never outlive the PID that supplied it. */
  private readonly packetClientsByPid_ = new Map<number, PacketSender>();
  readonly events = new BridgeEventBus();
  readonly apis: ApiHub;
  private readonly pipeline: IncomingPacketPipeline;
  private packetClient_: PacketSender | null = null;
  private packetClientPid_: number | null = null;
  private static readonly UPLOADED_FILE_CACHE_MAX = 1024;
  private uploadedFileMeta_ = new Map<string, UploadedFileMeta>();
  private clientSeq_ = 100000000 + (Date.now() % 1000000000);
  private msgRandom_ = (Date.now() & 0xFFFFFFFF) >>> 0;
  // Per-account dedup for QQ NT's already-deduped system pushes (#137).
  private readonly sysMsgDedup_ = new SysMsgDedup();
  private onlineClients_: readonly Readonly<OnlineDeviceInfo>[] | null = null;

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
      resolveGroupJoinRequest: async (groupId, uid, subType) => {
        const [main, filtered] = await Promise.allSettled([
          this.apis.contacts.fetchGroupRequestsByUid(false),
          this.apis.contacts.fetchGroupRequestsByUid(true),
        ]);
        if (main.status === 'rejected') {
          log.warn('group-request enrichment main inbox failed: group=%d uid=%s err=%s',
            groupId, uid, main.reason instanceof Error ? main.reason.message : String(main.reason));
        }
        if (filtered.status === 'rejected') {
          log.warn('group-request enrichment filtered inbox failed: group=%d uid=%s err=%s',
            groupId, uid, filtered.reason instanceof Error ? filtered.reason.message : String(filtered.reason));
        }
        if (main.status === 'rejected' && filtered.status === 'rejected') {
          throw new Error('failed to fetch group requests from both inboxes');
        }
        const requests = [
          ...(main.status === 'fulfilled' ? main.value : []),
          ...(filtered.status === 'fulfilled' ? filtered.value : []),
        ];
        return requests.find(r => {
          if (r.groupId !== groupId) return false;
          return subType === 'invite' ? r.invitorUid === uid : r.targetUid === uid;
        }) ?? null;
      },
      resolveGroupInviteCardSequence: async (groupId) => {
        const deadline = Date.now() + 1_000;
        do {
          const sequence = this.apis.contacts.getGroupInviteCardSequence(groupId);
          if (sequence) return sequence;
          await new Promise(resolve => setTimeout(resolve, 25));
        } while (Date.now() < deadline);
        return null;
      },
      rememberGroupInviteCardSequence: (groupUin, sequence) => {
        this.apis.contacts.rememberGroupInviteCardSequence(groupUin, sequence);
      },
    });
    this.pipeline.registerCmd(
      MSG_PUSH_CMD,
      (pkt, identity) => parseMsgPushOrThrow(
        pkt,
        identity,
        this.sysMsgDedup_,
      ),
    );
    this.pipeline.registerCmd(KICK_NT_CMD, parseKickNT);
    this.events.on('online_devices_changed', (event) => {
      const snapshot = event.devices.map((device) => Object.freeze({ ...device }));
      this.onlineClients_ = Object.freeze(snapshot);
      log.debug('online-device snapshot updated: uin=%s clients=%d types=%s',
        this.identity.uin, snapshot.length,
        snapshot.map((device) => device.clientType).join(','));
    });
  }

  dispose(): void {
    this.pids_.clear();
    this.receiveHealthByPid_.clear();
    this.packetClientsByPid_.clear();
    this.packetClient_ = null;
    this.packetClientPid_ = null;
    this.onlineClients_ = null;
    try {
      this.identity.close();
    } finally {
      // A close failure must remain visible to the caller, but must not leave
      // event subscribers attached to a Bridge that Manager already removed.
      this.events.clear();
    }
  }

  /** Legacy two-step setter retained for external compatibility. It assigns
   *  the sender to the most recently attached PID when one exists. New
   *  BridgeManager code uses bindPid() for an atomic transition. */
  setPacketClient(client: PacketSender): void {
    this.packetClient_ = client;
    const pids = [...this.pids_];
    const pid = pids.length > 0 ? pids[pids.length - 1]! : null;
    this.packetClientPid_ = pid;
    if (pid !== null) this.packetClientsByPid_.set(pid, client);
  }

  registerCmd(cmd: string, parser: CmdParser): void {
    this.pipeline.registerCmd(cmd, parser);
  }

  handlesCmd(cmd: string): boolean {
    return this.pipeline.handlesCmd(cmd);
  }

  /** Attach a process without a sender. Retained for compatibility; the
   *  manager uses bindPid() for the atomic PID+sender transition. Re-attaching
   *  deliberately refreshes recency. */
  attachPid(pid: number): void {
    this.pids_.delete(pid);
    this.pids_.add(pid);
    // A fresh/rebound login starts UNKNOWN-but-compatible. The receive
    // watchdog only flips this false after observing QQ's own heartbeat and
    // then missing the full stale + confirmation window.
    this.receiveHealthByPid_.set(pid, true);
  }

  /** Atomically attach a process and make its sender the active sender.
   *  Set insertion order is the recency order used for fallback. */
  bindPid(pid: number, client: PacketSender): void {
    const previousPid = this.packetClientPid_;
    const previousClient = this.packetClient_;
    this.attachPid(pid);
    this.packetClientsByPid_.set(pid, client);
    this.packetClient_ = client;
    this.packetClientPid_ = pid;
    if (previousPid !== pid || previousClient !== client) {
      runtimeLog.trace(
        'bridge_sender_fact event=selected uin=%j pid=%d previousPid=%j',
        this.identity.uin,
        pid,
        previousPid,
      );
    }
  }

  /** @internal BridgeManager lookup used when an incoming packet is the first
   *  observation that a live PID changed UIN. */
  packetClientForPid(pid: number): PacketSender | null {
    return this.packetClientsByPid_.get(pid) ?? null;
  }

  detachPid(pid: number): void {
    this.pids_.delete(pid);
    this.receiveHealthByPid_.delete(pid);
    this.packetClientsByPid_.delete(pid);

    if (this.packetClientPid_ !== pid) {
      // An unscoped legacy sender cannot be associated with a particular PID.
      // It is safe to retain while another PID exists, but never after the
      // Bridge becomes empty.
      if (this.pids_.size === 0) {
        this.packetClient_ = null;
        this.packetClientPid_ = null;
      }
      return;
    }

    this.selectFallbackPacketClient(pid);
  }
  hasPid(pid: number): boolean { return this.pids_.has(pid); }
  get empty(): boolean { return this.pids_.size === 0; }
  get activePid(): number | null {
    if (this.packetClientPid_ !== null && this.pids_.has(this.packetClientPid_)) {
      return this.packetClientPid_;
    }
    const pids = [...this.pids_];
    return pids.length > 0 ? pids[pids.length - 1]! : null;
  }
  get receiveHealthy(): boolean {
    for (const pid of this.pids_) {
      const healthy = this.receiveHealthByPid_.get(pid);
      if (healthy === undefined) {
        const message = `Bridge receive-health invariant violated: PID=${pid} has no health state`;
        log.error(message);
        throw new Error(message);
      }
      if (healthy) return true;
    }
    return false;
  }
  setPidReceiveHealthy(pid: number, healthy: boolean): void {
    if (!this.pids_.has(pid)) {
      throw new Error(`Bridge receive-health invariant violated: PID=${pid} is not attached`);
    }
    this.receiveHealthByPid_.set(pid, healthy);
  }
  getOnlineClients(): readonly Readonly<OnlineDeviceInfo>[] | null {
    return this.onlineClients_;
  }
  onPacket(pkt: PacketInfo): Promise<void> {
    return this.pipeline.process(pkt);
  }

  rememberUploadedFile(meta: UploadedFileMeta): void {
    if (!meta.fileId) return;
    if (this.uploadedFileMeta_.size >= Bridge.UPLOADED_FILE_CACHE_MAX) {
      // Map iteration order is insertion order — drop the oldest.
      const oldest = this.uploadedFileMeta_.keys().next().value;
      if (oldest !== undefined) this.uploadedFileMeta_.delete(oldest);
    }
    this.uploadedFileMeta_.set(meta.fileId, meta);
  }

  recallUploadedFile(fileId: string): UploadedFileMeta | undefined {
    if (!fileId) return undefined;
    return this.uploadedFileMeta_.get(fileId);
  }

  nextClientSequence(): number {
    return ++this.clientSeq_;
  }

  nextMessageRandom(): number {
    this.msgRandom_ = (this.msgRandom_ + 0x9E3779B9) >>> 0;
    return this.msgRandom_ & 0x7FFFFFFF;
  }
  async sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs = 15000): Promise<SendPacketResult> {
    if (!this.packetClient_) {
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
          success: false, gotResponse: false, errorCode: -1,
          errorMessage: 'no packet sender attached', responseData: null,
        };
      });
    }
    const startedAt = Date.now();
    const result = await this.packetClient_.sendPacket(serviceCmd, Buffer.from(body), timeoutMs);
    const elapsed = Date.now() - startedAt;
    const respLen = result.responseData ? result.responseData.length : 0;
    if (!result.success || result.errorCode !== 0) {
      // QQ-side rejection or transport failure — the usual root cause when an
      // action misbehaves. Warn (persisted) with cmd + code so a user's log
      // shows exactly where the chain broke.
      log.warn('packet %s failed: code=%d gotResponse=%s %s (uin=%s, %dB, %dms)',
        serviceCmd, result.errorCode, result.gotResponse,
        result.errorMessage ?? '', this.identity.uin, body.length, elapsed);
    } else {
      // Happy path — memory-only trace so the full chain shows under the
      // request's [req#N] when debugging, without flooding disk.
      log.trace(() => [`packet ${serviceCmd} ok (${body.length}B⇄${respLen}B, ${elapsed}ms)`]);
    }
    return result;
  }

  private selectFallbackPacketClient(detachedPid: number): void {
    const pids = [...this.pids_];
    for (let index = pids.length - 1; index >= 0; index -= 1) {
      const fallbackPid = pids[index]!;
      const fallback = this.packetClientsByPid_.get(fallbackPid);
      if (!fallback) continue;

      this.packetClient_ = fallback;
      this.packetClientPid_ = fallbackPid;
      runtimeLog.trace(
        'bridge_sender_fact event=fallback uin=%j detachedPid=%d fallbackPid=%d',
        this.identity.uin,
        detachedPid,
        fallbackPid,
      );
      log.debug(
        'packet sender fallback: UIN=%s detached PID=%d fallback PID=%d',
        this.identity.uin,
        detachedPid,
        fallbackPid,
      );
      return;
    }

    this.packetClient_ = null;
    this.packetClientPid_ = null;
    if (this.pids_.size > 0) {
      log.warn(
        'packet sender unavailable after PID detach: UIN=%s detached PID=%d remaining PIDs=%d',
        this.identity.uin,
        detachedPid,
        this.pids_.size,
      );
    }
  }
  async resolveUserUid(uin: number, groupId?: number): Promise<string> {
    return this.identity.resolveUid(uin, groupId);
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
  keyIndex: string
}
export { AiVoiceChatType };
export type { AiVoiceCategory, StrangerStatus };
