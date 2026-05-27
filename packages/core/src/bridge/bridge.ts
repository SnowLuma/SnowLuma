import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MSG_PUSH_CMD, parseMsgPush } from '@snowluma/protocol/msg-push';
import { IncomingPacketPipeline, type CmdParser } from '@snowluma/protocol/packet-pipeline';
import { buildApiHub, type ApiHub } from './apis';
import {
  AiVoiceChatType,
  type AiVoiceCategory,
  type StrangerStatus,
} from './apis/extras';
import type { BridgeInterface, BridgeKind } from './bridge-interface';

/**
 * Abstract base for every concrete account bridge (`InjectBridge`,
 * `ProtocolBridge`, …). Owns everything that is transport-agnostic:
 *
 *   - the per-account `IdentityService` (friend/group/uid cache + DB),
 *   - the typed `BridgeEventBus` (per-kind subscribers),
 *   - the `ApiHub` (typed wrappers around `sendRawPacket`),
 *   - the `IncomingPacketPipeline` (cmd → decoder dispatch),
 *   - the uploaded-file cache shared between `upload_*_file` and
 *     `send_msg`,
 *   - the monotonic `clientSequence` / `messageRandom` counters.
 *
 * Subclasses only have to provide:
 *
 *   1. `kind` / `id` — discriminators for `BridgeManager` bookkeeping
 *      and diagnostics.
 *   2. `sendRawPacket` — the actual wire-level transport. `InjectBridge`
 *      forwards to a `PacketSender` (the hook named-pipe client);
 *      `ProtocolBridge` will eventually forward to a long-lived TCP
 *      protocol client.
 *
 * The base class is intentionally abstract: callers never write
 * `new Bridge(...)`. Tests that want to exercise the common
 * pipeline / identity logic subclass `Bridge` (supplying the two
 * abstract members) or instantiate `InjectBridge` directly.
 */
export abstract class Bridge implements BridgeInterface {
  abstract readonly kind: BridgeKind;
  abstract readonly id: string;

  readonly uin: string;
  readonly identity: IdentityService;
  readonly events = new BridgeEventBus();
  readonly apis: ApiHub;

  private readonly pipeline: IncomingPacketPipeline;
  private static readonly UPLOADED_FILE_CACHE_MAX = 1024;
  private readonly uploadedFileMeta_ = new Map<string, UploadedFileMeta>();
  private clientSeq_ = 100000000 + (Date.now() % 1000000000);
  private msgRandom_ = (Date.now() & 0xFFFFFFFF) >>> 0;
  private disposed_ = false;

  constructor(identity: IdentityService) {
    this.identity = identity;
    this.uin = identity.uin;
    this.apis = buildApiHub(this);
    this.identity.setFetcher({
      fetchProfile: (uin) => this.apis.contacts.fetchUserProfile(uin),
      fetchGroupMemberList: (gid) => this.apis.contacts.fetchGroupMemberList(gid),
    });
    this.pipeline = new IncomingPacketPipeline({
      identity: this.identity,
      events: this.events,
      refreshMemberCache: (groupId, refreshGroupList, forceMemberList) =>
        this.refreshMemberCache(groupId, refreshGroupList, forceMemberList),
      resolveStrangerProfile: async (uid) => {
        try {
          const p = await this.apis.contacts.fetchUserProfileByUid(uid);
          if (p.uin <= 0) return null;
          return { uin: p.uin, nickname: p.nickname };
        } catch {
          return null;
        }
      },
      resolveGroupJoinRequest: async (groupId, uid, subType) => {
        try {
          const requests = await this.apis.contacts.fetchGroupRequests();
          const match = requests.find(r => {
            if (r.groupId !== groupId) return false;
            return subType === 'invite' ? r.invitorUid === uid : r.targetUid === uid;
          });
          if (!match) return null;
          return { comment: match.comment, sequence: match.sequence };
        } catch {
          return null;
        }
      },
    });
    this.pipeline.registerCmd(MSG_PUSH_CMD, parseMsgPush);
  }

  // ─── BridgeInterface plumbing ──────────────────────────────

  onPacket(packet: PacketInfo): void {
    this.pipeline.process(packet);
  }

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.identity.close();
    this.events.clear();
  }

  get isDisposed(): boolean { return this.disposed_; }

  // ─── Transport (abstract — implemented per-subclass) ────────────

  abstract sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ): Promise<SendPacketResult>;

  // ─── Pipeline registration (used by tests + extra cmd modules) ──────

  registerCmd(cmd: string, parser: CmdParser): void {
    this.pipeline.registerCmd(cmd, parser);
  }

  handlesCmd(cmd: string): boolean {
    return this.pipeline.handlesCmd(cmd);
  }

  // ─── Send-side protocol helpers (shared sequence generators) ────────

  nextClientSequence(): number {
    return ++this.clientSeq_;
  }

  nextMessageRandom(): number {
    this.msgRandom_ = (this.msgRandom_ + 0x9E3779B9) >>> 0;
    return this.msgRandom_ & 0x7FFFFFFF;
  }

  // ─── Uploaded-file cache ──────────────────────────────────

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

  // ─── Identity convenience ──────────────────────────────────

  async resolveUserUid(uin: number, groupId?: number): Promise<string> {
    return this.identity.resolveUid(uin, groupId);
  }

  // ─── Internal helpers ─────────────────────────────────────

  private async refreshMemberCache(
    groupId: number,
    refreshGroupList: boolean,
    forceMemberList: boolean,
  ): Promise<boolean> {
    if (refreshGroupList) {
      try { await this.apis.contacts.fetchGroupList(); } catch { /* ignore */ }
    }
    if (!this.identity.findGroup(groupId)) return false;
    await this.apis.contacts.fetchGroupMemberList(groupId, { force: forceMemberList });
    return true;
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

