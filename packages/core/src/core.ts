import type { ChannelCtx, ChannelKind } from '@snowluma/channel';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { UploadedFileMeta } from '@snowluma/protocol/bridge-context';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MSG_PUSH_CMD, parseMsgPush } from '@snowluma/protocol/msg-push';
import { IncomingPacketPipeline, type CmdParser } from '@snowluma/protocol/packet-pipeline';
import { buildApiHub, type ApiHub } from './apis';
import type { CoreCtx } from './core-ctx';

/**
 * `Core` — the QQ-account-level business object that sits on top of a
 * `Channel` transport (consumed indirectly via a `ChannelCtx`
 * capability POJO). Owns everything OneBot, the apis, and the msg-push
 * pipeline care about:
 *
 *   - `identity` (per-uin SQLite-backed roster + uid↔uin index),
 *   - the typed `BridgeEventBus` (subscribe to per-account events by kind),
 *   - the `ApiHub` (typed wrappers around `sendRawPacket`),
 *   - the `IncomingPacketPipeline` (cmd → decoder → emit on bus),
 *   - the uploaded-file cache (shared between `upload_*_file` and
 *     `send_msg`),
 *   - the monotonic `clientSequence` / `messageRandom` counters.
 *
 * The transport is opaque: `Core` only calls `channelCtx.sendRawPacket`
 * and subscribes via `channelCtx.onPacket` so all incoming packets flow
 * into its pipeline. Swap the transport (hook → socket) and everything
 * above keeps working unchanged because `Core` never holds the `Channel`
 * itself — only the capability POJO.
 *
 * Lifecycle is managed by `Hub`: the hub registers `ChannelAdapter`s,
 * builds a `ChannelCtx` from each freshly-available channel, materialises
 * a `Core` on the way up, and calls `dispose()` on the way down. OneBot
 * consumers see `CoreCtx` (the structural projection); never `Core`
 * itself.
 */
export class Core implements CoreCtx {
  readonly kind: ChannelKind;
  readonly id: string;
  readonly uin: string;
  readonly identity: IdentityService;
  readonly events = new BridgeEventBus();
  readonly apis: ApiHub;

  private readonly channelCtx_: ChannelCtx;
  private readonly pipeline_: IncomingPacketPipeline;
  private static readonly UPLOADED_FILE_CACHE_MAX = 1024;
  private readonly uploadedFileMeta_ = new Map<string, UploadedFileMeta>();
  private clientSeq_ = 100000000 + (Date.now() % 1000000000);
  private msgRandom_ = (Date.now() & 0xFFFFFFFF) >>> 0;
  private disposed_ = false;

  /**
   * @param channelCtx The capability POJO this core rides on top of.
   *                   `Core` calls `channelCtx.sendRawPacket` and
   *                   subscribes via `channelCtx.onPacket`. Built by
   *                   `Hub` from a concrete `Channel` via `makeChannelCtx`.
   * @param identity   Optional pre-built `IdentityService`. The default
   *                   opens the on-disk SQLite store at
   *                   `data/<uin>/snowluma_identity.db`; tests usually
   *                   pass `IdentityService.memory(uin)` to avoid touching
   *                   the filesystem.
   */
  constructor(channelCtx: ChannelCtx, identity: IdentityService = IdentityService.openForUin(channelCtx.uin)) {
    this.channelCtx_ = channelCtx;
    this.kind = channelCtx.kind;
    this.id = `${channelCtx.kind}:${channelCtx.uin}`;
    this.uin = channelCtx.uin;
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

    // Subscribe to inbound packets from the channel. The underlying
    // `Channel` only supports a single subscriber (us); the
    // `ChannelAdapter` pumps packets through `channel.deliverPacket`,
    // which `Hub` wires into us via `channelCtx.onPacket`.
    channelCtx.onPacket((pkt: PacketInfo) => this.pipeline_.process(pkt));
  }

  // ─── CoreCtx plumbing ────────────────────────────────────────────

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.channelCtx_.onPacket(null);
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
    return this.channelCtx_.sendRawPacket(serviceCmd, body, timeoutMs);
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
    if (this.uploadedFileMeta_.size >= Core.UPLOADED_FILE_CACHE_MAX) {
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
