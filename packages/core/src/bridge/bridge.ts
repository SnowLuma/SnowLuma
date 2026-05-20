import type { PacketSender, SendPacketResult } from '../protocol/packet-sender';
import type { PacketInfo } from '../protocol/types';
import type { BridgeInterface } from './bridge-interface';
import type { ForwardNodePayload } from './events';
import { IdentityService } from './identity-service';
import { MSG_PUSH_CMD, parseMsgPush } from './msg-push';
import { IncomingPacketPipeline, type CmdParser } from './packet-pipeline';
import type { FriendInfo, GroupMemberInfo, GroupRequestInfo, QQGroupInfo, UserProfileInfo } from './qq-info';
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
import {
  deleteFriend as deleteFriend_,
  setFriendAddRequest as setFriendAddRequest_,
  setFriendRemark as setFriendRemark_,
} from './actions/friend';
import {
  getGroupAtAllRemain as getGroupAtAllRemain_,
  kickGroupMember as kickGroupMember_,
  kickGroupMembers as kickGroupMembers_,
  leaveGroup as leaveGroup_,
  muteGroupAll as muteGroupAll_,
  muteGroupMember as muteGroupMember_,
  setGroupAddOption as setGroupAddOption_,
  setGroupAddRequest as setGroupAddRequest_,
  setGroupAdmin as setGroupAdmin_,
  setGroupCard as setGroupCard_,
  setGroupName as setGroupName_,
  setGroupRemark as setGroupRemark_,
  setGroupSearch as setGroupSearch_,
  setGroupSpecialTitle as setGroupSpecialTitle_,
} from './actions/group-admin';
import {
  commentGroupAlbumMedia as commentGroupAlbumMedia_,
  deleteGroupAlbumMedia as deleteGroupAlbumMedia_,
  getGroupAlbumMediaList as getGroupAlbumMediaList_,
  likeGroupAlbumMedia as likeGroupAlbumMedia_,
} from './actions/group-album';
import type { GroupFilesResult } from './actions/group-file';
import {
  createGroupFileFolder as createGroupFileFolder_,
  deleteGroupFile as deleteGroupFile_,
  deleteGroupFileFolder as deleteGroupFileFolder_,
  fetchGroupFileCount as fetchGroupFileCount_,
  fetchGroupFiles as fetchGroupFiles_,
  fetchGroupFileUrl as fetchGroupFileUrl_,
  fetchGroupPttUrlByNode as fetchGroupPttUrlByNode_,
  fetchGroupVideoUrlByNode as fetchGroupVideoUrlByNode_,
  fetchPrivateFileUrl as fetchPrivateFileUrl_,
  fetchPrivatePttUrlByNode as fetchPrivatePttUrlByNode_,
  fetchPrivateVideoUrlByNode as fetchPrivateVideoUrlByNode_,
  moveGroupFile as moveGroupFile_,
  renameGroupFileFolder as renameGroupFileFolder_,
  sendGroupFileMessage as sendGroupFileMessage_,
  uploadGroupFile as uploadGroupFile_,
  uploadPrivateFile as uploadPrivateFile_,
} from './actions/group-file';
import {
  setGroupEssence as setGroupEssence_,
} from './actions/group-message';
import {
  getEmojiLikes as getEmojiLikes_,
  sendLike as sendLike_,
  sendPoke as sendPoke_,
  setGroupReaction as setGroupReaction_,
} from './actions/interaction';
import {
  clickInlineKeyboardButton as clickInlineKeyboardButton_,
  getMiniAppArk as getMiniAppArk_,
  sendGroupSign as sendGroupSign_,
  translateEn2Zh as translateEn2Zh_,
} from './actions/misc';
import {
  fetchCustomFace as fetchCustomFace_,
  getProfileLike as getProfileLike_,
  getUnidirectionalFriendList as getUnidirectionalFriendList_,
  setAvatar as setAvatar_,
  setDiyOnlineStatus as setDiyOnlineStatus_,
  setGroupAvatar as setGroupAvatar_,
  setInputStatus as setInputStatus_,
  setOnlineStatus as setOnlineStatus_,
  setProfile as setProfile_,
  setSelfLongNick as setSelfLongNick_,
} from './actions/profile';
import type { MediaIndexNode } from './actions/shared';
import {
  fetchDownloadRKeys as fetchDownloadRKeys_,
  fetchFriendList as fetchFriendList_,
  fetchGroupList as fetchGroupList_,
  fetchGroupMemberList as fetchGroupMemberList_,
  fetchGroupRequests as fetchGroupRequests_,
  fetchUserProfile as fetchUserProfile_,
} from './bridge-contacts';
import { BridgeEventBus } from './event-bus';
import {
  deleteGroupNoticeByFid as deleteGroupNotice_,
  forceFetchClientKey as forceFetchClientKey_,
  getCookiesStr as getCookiesStr_,
  getCredentials as getCredentials_,
  getCsrfToken as getCsrfToken_,
  getGroupAlbumListWeb as getGroupAlbumListWeb_,
  getGroupEssence as getGroupEssence_,
  getGroupEssenceAll as getGroupEssenceAll_,
  getGroupHonorInfo as getGroupHonorInfo_,
  getGroupNotice as getGroupNotice_,
  sendGroupNotice as sendGroupNotice_,
  uploadImageToGroupAlbumWeb as uploadImageToGroupAlbumWeb_,
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
  // Throttle for fetchGroupMemberList(groupId): coalesces in-flight calls
  // and serves a fresh result for `kMemberListTtlMs` to all callers.
  // Without this, a busy OneBot client (e.g. MaiBot calling
  // get_group_member_info(no_cache=true) per inbound message) would
  // trigger one OIDB 0xfe7_3 per chat message per group; sustained rate
  // (>1k/h) is detected by Tencent risk-control and gets the account
  // banned for 7 days.
  private memberListInflight_ = new Map<number, Promise<GroupMemberInfo[]>>();
  private memberListLastFetch_ = new Map<number, { at: number; data: GroupMemberInfo[] }>();

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
    this.identity.setFetcher({
      fetchProfile: (uin) => this.fetchUserProfile(uin),
      fetchGroupMemberList: (gid) => this.fetchGroupMemberList(gid),
    });
    this.pipeline = new IncomingPacketPipeline({
      identity: this.identity,
      events: this.events,
      refreshMemberCache: (groupId, refreshGroupList, forceMemberList) =>
        this.refreshMemberCache(groupId, refreshGroupList, forceMemberList),
    });
    this.pipeline.registerCmd(MSG_PUSH_CMD, parseMsgPush);
    // Build Api hub eagerly. The Bridge instance IS the BridgeContext
    // — `this implements BridgeContext` is enforced via the
    // `BridgeInterface` declaration, which itself extends BridgeContext.
    this.apis = buildApiHub(this);
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
      try { await this.fetchGroupList(); } catch { /* ignore */ }
    }
    if (!this.identity.findGroup(groupId)) return false;
    await this.fetchGroupMemberList(groupId, { force: forceMemberList });
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

  // --- Delegated: Contact / info queries ---

  async fetchFriendList(): Promise<FriendInfo[]> { return fetchFriendList_(this); }
  async fetchGroupList(): Promise<QQGroupInfo[]> { return fetchGroupList_(this); }
  async fetchGroupMemberList(groupId: number, options: { force?: boolean } = {}): Promise<GroupMemberInfo[]> {
    const kMemberListTtlMs = 60_000;
    const now = Date.now();
    const last = this.memberListLastFetch_.get(groupId);
    if (!options.force && last && now - last.at < kMemberListTtlMs) {
      return last.data;
    }
    const inflight = this.memberListInflight_.get(groupId);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const data = await fetchGroupMemberList_(this, groupId);
        this.memberListLastFetch_.set(groupId, { at: Date.now(), data });
        return data;
      } finally {
        this.memberListInflight_.delete(groupId);
      }
    })();
    this.memberListInflight_.set(groupId, task);
    return task;
  }
  async fetchUserProfile(uin: number): Promise<UserProfileInfo> { return fetchUserProfile_(this, uin); }
  async fetchGroupRequests(filtered = false): Promise<GroupRequestInfo[]> { return fetchGroupRequests_(this, filtered); }
  async fetchDownloadRKeys(): Promise<DownloadRKeyInfo[]> { return fetchDownloadRKeys_(this); }

  // --- Delegated: Admin / action methods ---

  async muteGroupMember(groupId: number, userId: number, duration: number): Promise<void> { return muteGroupMember_(this, groupId, userId, duration); }
  async muteGroupAll(groupId: number, enable: boolean): Promise<void> { return muteGroupAll_(this, groupId, enable); }
  async setGroupAddOption(groupId: number, addType: number): Promise<void> { return setGroupAddOption_(this, groupId, addType); }
  async setGroupSearch(groupId: number): Promise<void> { return setGroupSearch_(this, groupId); }
  async kickGroupMember(groupId: number, userId: number, reject: boolean, reason = ''): Promise<void> { return kickGroupMember_(this, groupId, userId, reject, reason); }
  async kickGroupMembers(groupId: number, userIds: number[], reject: boolean): Promise<void> { return kickGroupMembers_(this, groupId, userIds, reject); }
  async leaveGroup(groupId: number): Promise<void> { return leaveGroup_(this, groupId); }
  async setGroupAdmin(groupId: number, userId: number, enable: boolean): Promise<void> { return setGroupAdmin_(this, groupId, userId, enable); }
  async setGroupCard(groupId: number, userId: number, card: string): Promise<void> { return setGroupCard_(this, groupId, userId, card); }
  async setGroupName(groupId: number, name: string): Promise<void> { return setGroupName_(this, groupId, name); }
  async setGroupSpecialTitle(groupId: number, userId: number, title: string): Promise<void> { return setGroupSpecialTitle_(this, groupId, userId, title); }
  async setFriendAddRequest(uidOrFlag: string, approve: boolean): Promise<void> { return setFriendAddRequest_(this, uidOrFlag, approve); }
  async deleteFriend(userId: number, block = false): Promise<void> { return deleteFriend_(this, userId, block); }
  async uploadGroupFile(groupId: number, file: string, name = '', folderId = '/', uploadFile = true): Promise<{ fileId: string | null }> {
    return uploadGroupFile_(this, groupId, file, name, folderId, uploadFile);
  }
  async uploadPrivateFile(userId: number, file: string, name = '', uploadFile = true): Promise<{ fileId: string | null }> {
    return uploadPrivateFile_(this, userId, file, name, uploadFile);
  }
  async sendGroupFileMessage(groupId: number, fileId: string): Promise<void> {
    return sendGroupFileMessage_(this, groupId, fileId);
  }
  async fetchGroupFiles(groupId: number, folderId = '/'): Promise<GroupFilesResult> { return fetchGroupFiles_(this, groupId, folderId); }
  async fetchGroupFileUrl(groupId: number, fileId: string, busId = 102): Promise<string> { return fetchGroupFileUrl_(this, groupId, fileId, busId); }
  async fetchPrivateFileUrl(userId: number, fileId: string, fileHash: string): Promise<string> { return fetchPrivateFileUrl_(this, userId, fileId, fileHash); }
  async fetchGroupPttUrlByNode(groupId: number, node: MediaIndexNode): Promise<string> { return fetchGroupPttUrlByNode_(this, groupId, node); }
  async fetchPrivatePttUrlByNode(node: MediaIndexNode): Promise<string> { return fetchPrivatePttUrlByNode_(this, node); }
  async fetchGroupVideoUrlByNode(groupId: number, node: MediaIndexNode): Promise<string> { return fetchGroupVideoUrlByNode_(this, groupId, node); }
  async fetchPrivateVideoUrlByNode(node: MediaIndexNode): Promise<string> { return fetchPrivateVideoUrlByNode_(this, node); }
  async uploadForwardNodes(nodes: ForwardNodePayload[], groupId?: number, userId?: number): Promise<string> { return uploadForwardNodes_(this, nodes, groupId, userId); }
  async fetchForwardNodes(resId: string): Promise<ForwardNodePayload[]> { return fetchForwardNodes_(this, resId); }
  async deleteGroupFile(groupId: number, fileId: string): Promise<void> { return deleteGroupFile_(this, groupId, fileId); }
  async moveGroupFile(groupId: number, fileId: string, parentDirectory: string, targetDirectory: string): Promise<void> { return moveGroupFile_(this, groupId, fileId, parentDirectory, targetDirectory); }
  async createGroupFileFolder(groupId: number, name: string, parentId = '/'): Promise<void> { return createGroupFileFolder_(this, groupId, name, parentId); }
  async deleteGroupFileFolder(groupId: number, folderId: string): Promise<void> { return deleteGroupFileFolder_(this, groupId, folderId); }
  async renameGroupFileFolder(groupId: number, folderId: string, newFolderName: string): Promise<void> { return renameGroupFileFolder_(this, groupId, folderId, newFolderName); }
  async setGroupAddRequest(groupId: number, sequence: number, eventType: number, approve: boolean, reason = '', filtered = false): Promise<void> { return setGroupAddRequest_(this, groupId, sequence, eventType, approve, reason, filtered); }
  async sendPoke(isGroup: boolean, peerUin: number, targetUin?: number): Promise<void> { return sendPoke_(this, isGroup, peerUin, targetUin); }
  async sendLike(userId: number, count: number): Promise<void> { return sendLike_(this, userId, count); }
  async setGroupEssence(groupId: number, sequence: number, random: number, enable: boolean): Promise<void> { return setGroupEssence_(this, groupId, sequence, random, enable); }
  async setGroupReaction(groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> { return setGroupReaction_(this, groupId, sequence, code, isSet); }
  // recall* / markRead* moved to apis/message.ts::MessageApi.
  async setFriendRemark(userId: number, remark: string): Promise<void> { return setFriendRemark_(this, userId, remark); }
  async setGroupRemark(groupId: number, remark: string): Promise<void> { return setGroupRemark_(this, groupId, remark); }
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

  async getGroupAlbumList(groupId: number): Promise<any> {
    return getGroupAlbumListWeb_(this, groupId);
  }

  async uploadImageToGroupAlbum(groupId: number, albumId: string, albumName: string, filePath: string): Promise<void> {
    return uploadImageToGroupAlbumWeb_(this, groupId, albumId, albumName, filePath);
  }

  async getGroupAlbumMediaList(groupId: number, albumId: string, attachInfo?: string): Promise<any> {
    return getGroupAlbumMediaList_(this, groupId, albumId, attachInfo);
  }

  async commentGroupAlbumMedia(groupId: number, albumId: string, lloc: string, content: string): Promise<any> {
    return commentGroupAlbumMedia_(this, groupId, albumId, lloc, content);
  }

  async likeGroupAlbumMedia(groupId: number, albumId: string, batchId: string, lloc: string | undefined, isLike: boolean): Promise<any> {
    return likeGroupAlbumMedia_(this, groupId, albumId, batchId, lloc, isLike);
  }

  async deleteGroupAlbumMedia(groupId: number, albumId: string, lloc: string): Promise<any> {
    return deleteGroupAlbumMedia_(this, groupId, albumId, lloc);
  }

  async sendGroupNotice(groupId: number, content: string, options?: any) {
    return sendGroupNotice_(this, groupId, content, options);
  }

  async getGroupNotice(groupId: number) {
    return getGroupNotice_(this, groupId);
  }

  async deleteGroupNotice(groupId: number, fid: string): Promise<boolean> {
    return deleteGroupNotice_(this, groupId, fid);
  }

  async fetchGroupFileCount(groupId: number): Promise<{ fileCount: number; maxCount: number }> { return fetchGroupFileCount_(this, groupId); }

  async getGroupAtAllRemain(groupId: number) {
    return getGroupAtAllRemain_(this, groupId);
  }
  // extend
  async setOnlineStatus(status: number, extStatus: number = 0, batteryStatus: number = 100): Promise<void> {
    return setOnlineStatus_(this, status, extStatus, batteryStatus);
  }
  async setDiyOnlineStatus(faceId: number, wording: string, faceType: number): Promise<void> {
    return setDiyOnlineStatus_(this, faceId, wording, faceType);
  }
  async setProfile(nickname?: string, personalNote?: string): Promise<void> {
    return setProfile_(this, nickname, personalNote);
  }
  async getCookiesStr(domain: string): Promise<string> { return getCookiesStr_(this, domain); }
  async getCsrfToken(): Promise<number> { return getCsrfToken_(this); }
  async getCredentials(domain: string) { return getCredentials_(this, domain); }
  async getProfileLike(userId?: number, start?: number, limit?: number) {
    return getProfileLike_(this, userId, start, limit);
  }
  async getUnidirectionalFriendList() {
    return getUnidirectionalFriendList_(this);
  }
  async setSelfLongNick(longNick: string) {
    return setSelfLongNick_(this, longNick);
  }
  async setInputStatus(userId: number, eventType: number) {
    return setInputStatus_(this, userId, eventType);
  }
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
  async setAvatar(source: string): Promise<void> {
    return setAvatar_(this, source);
  }
  async setGroupAvatar(groupId: number, source: string): Promise<void> {
    return setGroupAvatar_(this, groupId, source);
  }
  async fetchCustomFace(count?: number): Promise<string[]> {
    return fetchCustomFace_(this, count);
  }
  async getEmojiLikes(groupId: number, sequence: number, emojiId: string, emojiType?: number, count?: number, cookie?: string) {
    return getEmojiLikes_(this, groupId, sequence, emojiId, emojiType, count, cookie);
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

