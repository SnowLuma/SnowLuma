import type { BridgeInterface, BridgeKind } from '@snowluma/bridge';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { UploadedFileMeta } from '@snowluma/protocol/bridge-context';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MSG_PUSH_CMD, parseMsgPush } from '@snowluma/protocol/msg-push';
import { IncomingPacketPipeline, type CmdParser } from '@snowluma/protocol/packet-pipeline';
import type { AccountInterface } from './account-interface';
import { buildApiHub, type ApiHub } from './apis';

/**
 * `Account` — the QQ-account-level concept that sits on top of a low-
 * level `Bridge` transport. Owns everything OneBot, the apis, and the
 * msg-push pipeline care about:
 *
 *   - `identity` (per-uin SQLite-backed roster + uid↔uin index),
 *   - the typed `BridgeEventBus` (subscribe to bridge events by kind),
 *   - the `ApiHub` (typed wrappers around `sendRawPacket`),
 *   - the `IncomingPacketPipeline` (cmd → decoder → emit on bus),
 *   - the uploaded-file cache (shared between `upload_*_file` and
 *     `send_msg`),
 *   - the monotonic `clientSequence` / `messageRandom` counters.
 *
 * The transport is opaque: `Account` only calls `bridge.sendRawPacket`
 * and registers a single `setPacketHandler` so all incoming packets
 * flow into its pipeline. Swap the transport (hook → protocol) and
 * everything above keeps working unchanged.
 *
 * Lifecycle is managed by `AccountManager`: the manager subscribes to
 * `BridgeManager` add/remove callbacks, materialises an `Account` on
 * the way up, and calls `dispose()` on the way down. OneBot consumers
 * see `AccountInterface`; never `Account` itself.
 */
export class Account implements AccountInterface {
  readonly kind: BridgeKind;
  readonly id: string;
  readonly uin: string;
  readonly identity: IdentityService;
  readonly events = new BridgeEventBus();
  readonly apis: ApiHub;

  private readonly transport_: BridgeInterface;
  private readonly pipeline_: IncomingPacketPipeline;
  private static readonly UPLOADED_FILE_CACHE_MAX = 1024;
  private readonly uploadedFileMeta_ = new Map<string, UploadedFileMeta>();
  private clientSeq_ = 100000000 + (Date.now() % 1000000000);
  private msgRandom_ = (Date.now() & 0xFFFFFFFF) >>> 0;
  private disposed_ = false;

  /**
   * @param bridge   The low-level transport this account rides on top
   *                 of. `Account` calls `bridge.sendRawPacket` and
   *                 subscribes via `bridge.setPacketHandler`.
   * @param identity Optional pre-built `IdentityService`. The default
   *                 opens the on-disk SQLite store at
   *                 `data/<uin>/snowluma_identity.db`; tests usually
   *                 pass `IdentityService.memory(uin)` to avoid touching
   *                 the filesystem.
   */
  constructor(bridge: BridgeInterface, identity: IdentityService = IdentityService.openForUin(bridge.uin)) {
    this.transport_ = bridge;
    this.kind = bridge.kind;
    this.id = bridge.id;
    this.uin = bridge.uin;
    this.identity = identity;
    this.apis = buildApiHub(this);
    this.identity.setFetcher({
      fetchProfile: (uin) => this.apis.contacts.fetchUserProfile(uin),
      fetchGroupMemberList: (gid) => this.apis.contacts.fetchGroupMemberList(gid),
    });
    this.pipeline_ = new IncomingPacketPipeline({
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
    this.pipeline_.registerCmd(MSG_PUSH_CMD, parseMsgPush);

    // Subscribe to inbound packets from the transport. `Bridge` only
    // ever supports a single subscriber (us); the `BridgeAdapter`
    // pumps packets through `bridge.deliverPacket`.
    bridge.setPacketHandler((pkt: PacketInfo) => this.pipeline_.process(pkt));
  }

  // ─── AccountInterface plumbing ─────────────────────────────────

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.transport_.setPacketHandler(null);
    this.identity.close();
    this.events.clear();
  }

  get isDisposed(): boolean { return this.disposed_; }

  // ─── Transport (proxied to the underlying Bridge) ──────────────

  async sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ): Promise<SendPacketResult> {
    return this.transport_.sendRawPacket(serviceCmd, body, timeoutMs);
  }

  // ─── Pipeline registration (used by tests + extra cmd modules) ─

  registerCmd(cmd: string, parser: CmdParser): void {
    this.pipeline_.registerCmd(cmd, parser);
  }

  handlesCmd(cmd: string): boolean {
    return this.pipeline_.handlesCmd(cmd);
  }

  // ─── Send-side protocol helpers (shared sequence generators) ───

  nextClientSequence(): number {
    return ++this.clientSeq_;
  }

  nextMessageRandom(): number {
    this.msgRandom_ = (this.msgRandom_ + 0x9E3779B9) >>> 0;
    return this.msgRandom_ & 0x7FFFFFFF;
  }

  // ─── Uploaded-file cache ───────────────────────────────────────

  rememberUploadedFile(meta: UploadedFileMeta): void {
    if (!meta.fileId) return;
    if (this.uploadedFileMeta_.size >= Account.UPLOADED_FILE_CACHE_MAX) {
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

  // ─── Identity convenience ──────────────────────────────────────

  async resolveUserUid(uin: number, groupId?: number): Promise<string> {
    return this.identity.resolveUid(uin, groupId);
  }

  // ─── Internal helpers ──────────────────────────────────────────

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
