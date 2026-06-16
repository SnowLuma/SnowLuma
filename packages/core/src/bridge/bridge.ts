import { createLogger } from '@snowluma/common/logger';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
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
import type { BridgeInterface } from './bridge-interface';

const log = createLogger('Bridge');

export class Bridge implements BridgeInterface {
  readonly identity: IdentityService;
  private pids_ = new Set<number>();
  readonly events = new BridgeEventBus();
  readonly apis: ApiHub;
  private readonly pipeline: IncomingPacketPipeline;
  private packetClient_: PacketSender | null = null;
  private static readonly UPLOADED_FILE_CACHE_MAX = 1024;
  private uploadedFileMeta_ = new Map<string, UploadedFileMeta>();
  private clientSeq_ = 100000000 + (Date.now() % 1000000000);
  private msgRandom_ = (Date.now() & 0xFFFFFFFF) >>> 0;

  constructor(identity: IdentityService) {
    this.identity = identity;
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

  dispose(): void {
    this.identity.close();
    this.events.clear();
  }

  setPacketClient(client: PacketSender): void {
    this.packetClient_ = client;
  }

  registerCmd(cmd: string, parser: CmdParser): void {
    this.pipeline.registerCmd(cmd, parser);
  }

  handlesCmd(cmd: string): boolean {
    return this.pipeline.handlesCmd(cmd);
  }

  attachPid(pid: number): void {
    this.pids_.add(pid);
  }
  detachPid(pid: number): void {
    this.pids_.delete(pid);
  }
  hasPid(pid: number): boolean { return this.pids_.has(pid); }
  get empty(): boolean { return this.pids_.size === 0; }
  get activePid(): number | null {
    for (const pid of this.pids_) return pid;
    return null;
  }
  onPacket(pkt: PacketInfo): void {
    this.pipeline.process(pkt);
  }

  private async refreshMemberCache(groupId: number, refreshGroupList: boolean, forceMemberList: boolean): Promise<boolean> {
    if (refreshGroupList) {
      try { await this.apis.contacts.fetchGroupList(); } catch { /* ignore */ }
    }
    if (!this.identity.findGroup(groupId)) return false;
    await this.apis.contacts.fetchGroupMemberList(groupId, { force: forceMemberList });
    return true;
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
      log.warn('packet %s dropped: no packet sender attached', serviceCmd);
      return {
        success: false, gotResponse: false, errorCode: -1,
        errorMessage: 'no packet sender attached', responseData: null,
      };
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

