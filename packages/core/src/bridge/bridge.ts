import type { PacketSender, SendPacketResult } from '../protocol/packet-sender';
import type { PacketInfo } from '../protocol/types';
import type { BridgeInterface } from './bridge-interface';
import type { ForwardNodePayload } from './events';
import { IdentityService } from './identity-service';
import { MSG_PUSH_CMD, parseMsgPush } from './msg-push';
import { IncomingPacketPipeline, type CmdParser } from './packet-pipeline';
// qq-info types are no longer used directly in this file — they live
// inside the Api classes that own those fetches (apis/contacts.ts).
import { type ApiHub, buildApiHub } from './apis';

// Delegated modules
import {
  AiVoiceChatType,
  cancelGroupTodo as cancelGroupTodo_,
  completeGroupTodo as completeGroupTodo_,
  fetchAiVoice as fetchAiVoice_,
  fetchAiVoiceList as fetchAiVoiceList_,
  getStrangerStatus as getStrangerStatus_,
  setGroupTodo as setGroupTodo_,
  type AiVoiceCategory,
  type AiVoiceChatType as AiVoiceChatTypeT,
  type StrangerStatus,
} from './actions/extras';
import {
  fetchForwardNodes as fetchForwardNodes_,
  uploadForwardNodes as uploadForwardNodes_,
} from './actions/forward';
// actions/friend.ts removed — moved to apis/friend.ts::FriendApi.
// actions/group-admin.ts removed — moved to `apis/group-admin.ts::GroupAdminApi`.
// actions/group-album.ts removed — moved to `apis/group-album.ts::GroupAlbumApi`.
// Group file CRUD + private c2c upload + media URL resolvers moved to
// `apis.groupFile` (see `apis/group-file.ts::GroupFileApi`). The shared
// result type still lives here because the OneBot side imports it
// through bridge.ts.
import type { GroupFilesResult } from './apis/group-file';
// actions/group-message.ts removed — `setGroupEssence` moved to
//   apis/interaction.ts::InteractionApi. The recall/markRead helpers
//   were absorbed into MessageApi back in commit 1.
// actions/interaction.ts removed — sendPoke/sendLike/setReaction/
//   getEmojiLikes moved to apis/interaction.ts::InteractionApi.
import {
  clickInlineKeyboardButton as clickInlineKeyboardButton_,
  getMiniAppArk as getMiniAppArk_,
  sendGroupSign as sendGroupSign_,
  translateEn2Zh as translateEn2Zh_,
} from './actions/misc';
// actions/profile.ts removed — moved to apis/profile.ts::ProfileApi.
// `bridge-contacts.ts` removed — its 6 functions are now methods on
// `apis.contacts` (see `apis/contacts.ts::ContactsApi`).
import { BridgeEventBus } from './event-bus';
import {
  deleteGroupNoticeByFid as deleteGroupNotice_,
  forceFetchClientKey as forceFetchClientKey_,
  getCookiesStr as getCookiesStr_,
  getCredentials as getCredentials_,
  getCsrfToken as getCsrfToken_,
  getGroupEssence as getGroupEssence_,
  getGroupEssenceAll as getGroupEssenceAll_,
  getGroupHonorInfo as getGroupHonorInfo_,
  getGroupNotice as getGroupNotice_,
  sendGroupNotice as sendGroupNotice_,
} from './web-actions';
import type { WebHonorType } from './web/group-honor';
export { AiVoiceChatType };
export type { AiVoiceCategory, StrangerStatus };

export interface SendMessageReceipt {
  messageId: number;
  sequence: number;
  clientSequence: number;
  random: number;
  timestamp: number;
}

/**
 * Metadata remembered after `upload_group_file` / `upload_private_file`
 * succeeds. Lets the OneBot send-message path reconstruct the full
 * payload when the caller only echoes the `file_id` back later. See
 * `Bridge.rememberUploadedFile` / `recallUploadedFile`.
 */
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

export class Bridge implements BridgeInterface {
  readonly identity: IdentityService;
  private pids_ = new Set<number>();
  /**
   * Per-kind event subscription. Replaces the legacy single-callback
   * firehose: downstream consumers now register exactly the kinds they
   * care about and the pipeline fans out in parallel.
   */
  readonly events = new BridgeEventBus();
  /**
   * Typed Api hub. Each entry is a class encapsulating one logical
   * area of the QQ protocol (sending messages, group admin, file
   * uploads, etc.). Built eagerly in the constructor — every Bridge
   * instance gets its own `apis.*` set with `this` (typed as
   * `BridgeContext`) injected. See `apis/index.ts`.
   */
  readonly apis: ApiHub;
  private readonly pipeline: IncomingPacketPipeline;
  private packetClient_: PacketSender | null = null;
  // (fetchGroupMemberList throttle cache moved to ContactsApi — same
  // 60s TTL + inflight coalesce semantics, just owned by the Api class
  // that exposes the method.)

  // ── Uploaded-file metadata cache ────────────────────────────────────
  //
  // After a file goes through `upload_group_file` / `upload_private_file`
  // we remember the (fileName, fileSize, fileMd5, fileHash) tuple keyed
  // by the returned file_id. The OneBot send-message paths consult this
  // when the caller later passes `{type:'file', file_id:'xxx'}` without
  // the rest of the metadata — c2c file send needs the size/md5/name
  // for the wire packet (server-side rejection / "0 byte file" otherwise),
  // and the group send path falls back to the name for the log line.
  //
  // Bounded at ~1024 entries with simple FIFO eviction. Files older
  // than 7 days expire on QQ's side anyway, so this isn't load-bearing
  // for correctness — just a UX convenience cache so the OneBot caller
  // doesn't have to thread the metadata themselves between upload and
  // send_msg.
  private static readonly UPLOADED_FILE_CACHE_MAX = 1024;
  private uploadedFileMeta_ = new Map<string, UploadedFileMeta>();

  // Sequence and random generators for outgoing messages
  private clientSeq_ = 100000000 + (Date.now() % 1000000000);
  private msgRandom_ = (Date.now() & 0xFFFFFFFF) >>> 0;

  constructor(identity: IdentityService) {
    this.identity = identity;
    // Build Api hub FIRST — `setFetcher` below installs callbacks
    // that reach into `this.apis.contacts.*`, so the hub must exist
    // by the time those callbacks could fire. The Bridge instance IS
    // the BridgeContext (Bridge implements BridgeInterface which
    // includes the BridgeContext surface).
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

  // --- PID management ---

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

  // --- Packet dispatch ---

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

  // --- Uploaded-file metadata cache ---

  /**
   * Remember a freshly-uploaded file so a later `send_*_msg` carrying
   * just the file_id can reconstruct the full c2c-file packet (fileName
   * / fileSize / fileMd5 are required by the QQ NT server's c2c file
   * intake, even if only the uuid is needed for the OIDB lookup
   * internally — without them the file shows as 0 B in the recipient's
   * chat or is silently rejected). Insertion is FIFO; oldest entry is
   * evicted when the cache hits `UPLOADED_FILE_CACHE_MAX`.
   */
  rememberUploadedFile(meta: UploadedFileMeta): void {
    if (!meta.fileId) return;
    if (this.uploadedFileMeta_.size >= Bridge.UPLOADED_FILE_CACHE_MAX) {
      // Map iteration order is insertion order — drop the oldest.
      const oldest = this.uploadedFileMeta_.keys().next().value;
      if (oldest !== undefined) this.uploadedFileMeta_.delete(oldest);
    }
    this.uploadedFileMeta_.set(meta.fileId, meta);
  }

  /**
   * Recall metadata for a previously-uploaded file. Returns `undefined`
   * if the file_id was never uploaded through this bridge instance, or
   * if it's been evicted from the cache.
   */
  recallUploadedFile(fileId: string): UploadedFileMeta | undefined {
    if (!fileId) return undefined;
    return this.uploadedFileMeta_.get(fileId);
  }

  // --- Sequence / random generators ---
  //
  // `public` (formerly `private`) because the Api classes in
  // `apis/*.ts` need them to build `SendMessageRequest` packets. Part
  // of the `BridgeContext` surface, so a third party that only sees
  // `BridgeContext` can still synthesise wire packets without reaching
  // into the concrete Bridge class.

  nextClientSequence(): number {
    return ++this.clientSeq_;
  }

  nextMessageRandom(): number {
    this.msgRandom_ = (this.msgRandom_ + 0x9E3779B9) >>> 0;
    return this.msgRandom_ & 0x7FFFFFFF;
  }

  // --- Send packet (raw) ---

  async sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs = 15000): Promise<SendPacketResult> {
    if (!this.packetClient_) {
      return {
        success: false, gotResponse: false, errorCode: -1,
        errorMessage: 'no packet sender attached', responseData: null,
      };
    }
    return this.packetClient_.sendPacket(serviceCmd, Buffer.from(body), timeoutMs);
  }

  // `Bridge.SEND_MSG_CMD` and the inline `sendGroupMessage` /
  // `sendPrivateMessage` / `sendC2cFileMessage` implementations were
  // moved to `apis/message.ts::MessageApi` as part of the #6
  // Api-on-ctx refactor. Callers route through `bridge.apis.message.*`.

  // --- Delegated: OIDB helpers ---

  async resolveUserUid(uin: number, groupId?: number): Promise<string> {
    return this.identity.resolveUid(uin, groupId);
  }

  // fetchFriendList / fetchGroupList / fetchGroupMemberList /
  // fetchUserProfile / fetchGroupRequests / fetchDownloadRKeys
  // moved to apis.contacts (see apis/contacts.ts::ContactsApi).

  // --- Delegated: action methods ---
  //
  // GroupAdmin methods (mute/kick/admin/card/name/title/leave/
  // add-option/search/add-request/remark/at-all-remain) moved to
  // apis.groupAdmin (apis/group-admin.ts::GroupAdminApi).
  // Friend methods (handleRequest/delete/setRemark) moved to
  // apis.friend.
  // GroupFile methods (upload/uploadPrivate/publish/list/getUrl/
  // getPrivateUrl/{Ptt,Video}Url/getPrivate{Ptt,Video}Url/delete/move/
  // createFolder/deleteFolder/renameFolder/getCount) moved to
  // apis.groupFile (apis/group-file.ts::GroupFileApi).
  async uploadForwardNodes(nodes: ForwardNodePayload[], groupId?: number, userId?: number): Promise<string> { return uploadForwardNodes_(this, nodes, groupId, userId); }
  async fetchForwardNodes(resId: string): Promise<ForwardNodePayload[]> { return fetchForwardNodes_(this, resId); }
  // Interaction methods (sendPoke/sendLike/setReaction/setEssence/
  // getEmojiLikes) moved to apis.interaction.
  // recall* / markRead* moved to apis/message.ts::MessageApi.
  async getGroupHonorInfo(groupId: number, type: WebHonorType | string): Promise<any> {
    return getGroupHonorInfo_(this, groupId, type);
  }
  async forceFetchClientKey(): Promise<ClientKeyInfo> { return forceFetchClientKey_(this) }
  async getGroupEssence(groupId: number, pageStart: number = 0, pageLimit: number = 50): Promise<any> {
    return getGroupEssence_(this, groupId, pageStart, pageLimit);
  }

  async getGroupEssenceAll(groupId: number): Promise<any> {
    return getGroupEssenceAll_(this, groupId);
  }

  // GroupAlbum methods (list/upload/getMediaList/comment/like/delete)
  // moved to apis.groupAlbum (apis/group-album.ts::GroupAlbumApi).

  async sendGroupNotice(groupId: number, content: string, options?: any) {
    return sendGroupNotice_(this, groupId, content, options);
  }

  async getGroupNotice(groupId: number) {
    return getGroupNotice_(this, groupId);
  }

  async deleteGroupNotice(groupId: number, fid: string): Promise<boolean> {
    return deleteGroupNotice_(this, groupId, fid);
  }

  // extend
  // Profile methods (setOnlineStatus / setDiyOnlineStatus / setProfile /
  // setSelfLongNick / setInputStatus / setAvatar / setGroupAvatar /
  // fetchCustomFace / getLike / getUnidirectionalFriendList) moved to
  // apis.profile.
  async getCookiesStr(domain: string): Promise<string> { return getCookiesStr_(this, domain); }
  async getCsrfToken(): Promise<number> { return getCsrfToken_(this); }
  async getCredentials(domain: string) { return getCredentials_(this, domain); }
  async translateEn2Zh(words: string[]) {
    return translateEn2Zh_(this, words);
  }
  async getMiniAppArk(type: string, title: string, desc: string, picUrl: string, jumpUrl: string) {
    return getMiniAppArk_(this, type, title, desc, picUrl, jumpUrl);
  }
  async clickInlineKeyboardButton(groupId: number, botAppid: number, buttonId: string, callbackData: string, msgSeq: number) {
    return clickInlineKeyboardButton_(this, groupId, botAppid, buttonId, callbackData, msgSeq);
  }
  async sendGroupSign(groupId: number) {
    return sendGroupSign_(this, groupId);
  }

  // --- Tier-2 napcat-parity extras (group todo, stranger status, AI voice) ---

  async setGroupTodo(groupId: number, msgSeq: bigint | number | string): Promise<void> {
    return setGroupTodo_(this, groupId, BigInt(msgSeq));
  }
  async completeGroupTodo(groupId: number, msgSeq: bigint | number | string): Promise<void> {
    return completeGroupTodo_(this, groupId, BigInt(msgSeq));
  }
  async cancelGroupTodo(groupId: number, msgSeq: bigint | number | string): Promise<void> {
    return cancelGroupTodo_(this, groupId, BigInt(msgSeq));
  }
  async getStrangerStatus(uin: number): Promise<StrangerStatus | null> {
    return getStrangerStatus_(this, uin);
  }
  async fetchAiVoiceList(groupId: number, chatType: AiVoiceChatTypeT): Promise<AiVoiceCategory[]> {
    return fetchAiVoiceList_(this, groupId, chatType);
  }
  async fetchAiVoice(groupId: number, voiceId: string, text: string, chatType: AiVoiceChatTypeT) {
    return fetchAiVoice_(this, groupId, voiceId, text, chatType);
  }
}

