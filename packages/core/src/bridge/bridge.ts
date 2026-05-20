// Bridge — per-UIN session: handler registration, packet dispatch, event routing.
// Supports packet sending via native addon.
// Heavy OIDB / contact / action logic is split into bridge-oidb, bridge-contacts, bridge-actions.

import type { PacketInfo } from '../protocol/types';
import type { ForwardNodePayload, QQEventVariant, MessageElement } from './events';
import type { FriendInfo, QQGroupInfo, GroupMemberInfo, UserProfileInfo, GroupRequestInfo } from './qq-info';
import { MSG_PUSH_CMD, parseMsgPush } from './msg-push';
import type { PacketSender, SendPacketResult } from '../protocol/packet-sender';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import { buildSendElems } from './element-builder';
import { IdentityService } from './identity-service';
import type { BridgeInterface } from './bridge-interface';
import { IncomingPacketPipeline, type CmdParser } from './packet-pipeline';
import { createLogger } from '../utils/logger';
import type {
  SendMessageRequest,
  SendMessageResponse,
} from './proto/proton/action';
import type { FileExtra } from './proto/proton/message';

// Delegated modules
import {
  fetchFriendList as fetchFriendList_,
  fetchGroupList as fetchGroupList_,
  fetchGroupMemberList as fetchGroupMemberList_,
  fetchUserProfile as fetchUserProfile_,
  fetchGroupRequests as fetchGroupRequests_,
  fetchDownloadRKeys as fetchDownloadRKeys_,
} from './bridge-contacts';
import type { WebHonorType } from './web/group-honor';
import {
  muteGroupMember as muteGroupMember_,
  muteGroupAll as muteGroupAll_,
  setGroupAddOption as setGroupAddOption_,
  setGroupSearch as setGroupSearch_,
  setGroupAddRequest as setGroupAddRequest_,
  kickGroupMember as kickGroupMember_,
  kickGroupMembers as kickGroupMembers_,
  leaveGroup as leaveGroup_,
  setGroupAdmin as setGroupAdmin_,
  setGroupCard as setGroupCard_,
  setGroupName as setGroupName_,
  setGroupSpecialTitle as setGroupSpecialTitle_,
  setGroupRemark as setGroupRemark_,
  getGroupAtAllRemain as getGroupAtAllRemain_,
} from './actions/group-admin';
import {
  uploadGroupFile as uploadGroupFile_,
  uploadPrivateFile as uploadPrivateFile_,
  sendGroupFileMessage as sendGroupFileMessage_,
  fetchGroupFiles as fetchGroupFiles_,
  fetchGroupFileUrl as fetchGroupFileUrl_,
  fetchPrivateFileUrl as fetchPrivateFileUrl_,
  fetchGroupPttUrlByNode as fetchGroupPttUrlByNode_,
  fetchPrivatePttUrlByNode as fetchPrivatePttUrlByNode_,
  fetchGroupVideoUrlByNode as fetchGroupVideoUrlByNode_,
  fetchPrivateVideoUrlByNode as fetchPrivateVideoUrlByNode_,
  deleteGroupFile as deleteGroupFile_,
  moveGroupFile as moveGroupFile_,
  createGroupFileFolder as createGroupFileFolder_,
  deleteGroupFileFolder as deleteGroupFileFolder_,
  renameGroupFileFolder as renameGroupFileFolder_,
  fetchGroupFileCount as fetchGroupFileCount_,
} from './actions/group-file';
import {
  recallGroupMessage as recallGroupMessage_,
  recallPrivateMessage as recallPrivateMessage_,
  markPrivateMessageRead as markGroupMsgAsRead_,
  markGroupMessageRead as markPrivateMsgAsRead_,
  setGroupEssence as setGroupEssence_,
} from './actions/group-message';
import {
  sendPoke as sendPoke_,
  sendLike as sendLike_,
  setGroupReaction as setGroupReaction_,
  getEmojiLikes as getEmojiLikes_,
} from './actions/interaction';
import {
  uploadForwardNodes as uploadForwardNodes_,
  fetchForwardNodes as fetchForwardNodes_,
} from './actions/forward';
import {
  setFriendAddRequest as setFriendAddRequest_,
  deleteFriend as deleteFriend_,
  setFriendRemark as setFriendRemark_,
} from './actions/friend';
import {
  setOnlineStatus as setOnlineStatus_,
  setDiyOnlineStatus as setDiyOnlineStatus_,
  setProfile as setProfile_,
  setSelfLongNick as setSelfLongNick_,
  setInputStatus as setInputStatus_,
  setAvatar as setAvatar_,
  setGroupAvatar as setGroupAvatar_,
  fetchCustomFace as fetchCustomFace_,
  getProfileLike as getProfileLike_,
  getUnidirectionalFriendList as getUnidirectionalFriendList_,
} from './actions/profile';
import {
  translateEn2Zh as translateEn2Zh_,
  getMiniAppArk as getMiniAppArk_,
  clickInlineKeyboardButton as clickInlineKeyboardButton_,
  sendGroupSign as sendGroupSign_,
} from './actions/misc';
import {
  setGroupTodo as setGroupTodo_,
  completeGroupTodo as completeGroupTodo_,
  cancelGroupTodo as cancelGroupTodo_,
  getStrangerStatus as getStrangerStatus_,
  fetchAiVoiceList as fetchAiVoiceList_,
  fetchAiVoice as fetchAiVoice_,
  AiVoiceChatType,
  type AiVoiceCategory,
  type AiVoiceChatType as AiVoiceChatTypeT,
  type StrangerStatus,
} from './actions/extras';
export { AiVoiceChatType };
export type { AiVoiceCategory, StrangerStatus };
import {
  getGroupHonorInfo as getGroupHonorInfo_,
  forceFetchClientKey as forceFetchClientKey_,
  getGroupEssence as getGroupEssence_,
  getGroupEssenceAll as getGroupEssenceAll_,
  sendGroupNotice as sendGroupNotice_,
  getGroupNotice as getGroupNotice_,
  deleteGroupNoticeByFid as deleteGroupNotice_,
  getCookiesStr as getCookiesStr_,
  getCsrfToken as getCsrfToken_,
  getCredentials as getCredentials_,
  getGroupAlbumListWeb as getGroupAlbumListWeb_,
  uploadImageToGroupAlbumWeb as uploadImageToGroupAlbumWeb_,
} from './web-actions';
import { getGroupAlbumMediaList as getGroupAlbumMediaList_,
  commentGroupAlbumMedia as commentGroupAlbumMedia_,
  likeGroupAlbumMedia as likeGroupAlbumMedia_,
  deleteGroupAlbumMedia as deleteGroupAlbumMedia_,
} from './actions/group-album';
import type { GroupFilesResult } from './actions/group-file';
import type { MediaIndexNode } from './actions/shared';
import { BridgeEventBus } from './event-bus';

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

const log = createLogger('Bridge');

export class Bridge implements BridgeInterface {
  private static readonly SEND_MSG_CMD = 'MessageSvc.PbSendMsg';

  readonly identity: IdentityService;
  private pids_ = new Set<number>();
  /**
   * Per-kind event subscription. Replaces the legacy single-callback
   * firehose: downstream consumers now register exactly the kinds they
   * care about and the pipeline fans out in parallel.
   */
  readonly events = new BridgeEventBus();
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

  private nextClientSequence(): number {
    return ++this.clientSeq_;
  }

  private nextMessageRandom(): number {
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

  // --- Send message (high-level) ---

  async sendGroupMessage(groupId: number, elements: MessageElement[]): Promise<SendMessageReceipt> {
    if (elements.length === 0) throw new Error('message is empty');

    const protoElems = await buildSendElems(elements, { bridge: this, groupId });
    const random = this.nextMessageRandom();

    const request = protobuf_encode<SendMessageRequest>({
      routingHead: {
        grp: { groupCode: BigInt(groupId) },
      },
      contentHead: {
        type: 1,
      },
      messageBody: {
        richText: {
          elems: protoElems,
        },
      } as any,
      clientSequence: 0,
      random,
      syncCookie: new Uint8Array(0),
      via: 0,
      dataStatist: 0,
      multiSendSeq: 0,
    });

    const result = await this.sendRawPacket(Bridge.SEND_MSG_CMD, request);

    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send group message failed: ${result.errorMessage || 'no response'}`);
    }

    const response = protobuf_decode<SendMessageResponse>(result.responseData);
    if (!response) {
      throw new Error('failed to decode SendMessageResponse');
    }
    if (response.result !== undefined && response.result !== 0) {
      throw new Error(`send group message rejected: result=${response.result} err=${response.errMsg ?? ''}`);
    }

    const seq = response.groupSequence ?? 0;
    const messageId = (random & 0x7FFFFFFF) || seq;
    const timestamp = response.timestamp1 ?? Math.floor(Date.now() / 1000);

    return {
      messageId,
      sequence: seq,
      clientSequence: 0,
      random,
      timestamp,
    };
  }

  async sendPrivateMessage(userUin: number, elements: MessageElement[]): Promise<SendMessageReceipt> {
    if (elements.length === 0) throw new Error('message is empty');

    // Resolve UID for media upload and the final c2c routing head.
    let userUid = '';
    const hasMedia = elements.some(e => e.type === 'image' || e.type === 'record' || e.type === 'video');
    if (hasMedia) {
      userUid = await this.resolveUserUid(userUin);
    }

    const protoElems = await buildSendElems(elements, { bridge: this, userUid });
    const random = this.nextMessageRandom();
    const clientSeq = this.nextClientSequence();

    const request = protobuf_encode<SendMessageRequest>({
      routingHead: {
        c2c: {
          uin: userUin,
          ...(userUid ? { uid: userUid } : {}),
        },
      },
      contentHead: {
        type: 1,
        subType: 0,
        c2cCmd: 11,
      },
      messageBody: {
        richText: {
          elems: protoElems,
        },
      } as any,
      clientSequence: clientSeq,
      random,
      syncCookie: new Uint8Array(0),
      via: 0,
      dataStatist: 0,
      ctrl: {
        msgFlag: Math.floor(Date.now() / 1000),
      },
      multiSendSeq: 0,
    });

    const result = await this.sendRawPacket(Bridge.SEND_MSG_CMD, request);

    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send private message failed: ${result.errorMessage || 'no response'}`);
    }

    const response = protobuf_decode<SendMessageResponse>(result.responseData);
    if (!response) {
      throw new Error('failed to decode SendMessageResponse');
    }
    if (response.result !== undefined && response.result !== 0) {
      throw new Error(`send private message rejected: result=${response.result} err=${response.errMsg ?? ''}`);
    }

    const seq = response.privateSequence ?? 0;
    const messageId = (random & 0x7FFFFFFF) || seq;
    const timestamp = response.timestamp1 ?? Math.floor(Date.now() / 1000);

    return {
      messageId,
      sequence: seq,
      clientSequence: clientSeq,
      random,
      timestamp,
    };
  }

  /**
   * Send a c2c file as a chat message.
   *
   * The wire shape isn't the same as a regular c2c message — the c2c
   * file path uses three slots that differ from a normal text/image
   * send (verified against `dev/Lagrange.Core/.../MessagePacker.cs:
   * BuildPacketBase` + `FileEntity.PackMessageContent`):
   *
   *   1. `routingHead.trans0x211 { ccCmd: 4, uid: peer }` instead of
   *      `routingHead.c2c { uin, uid }`. The server rejects c2c file
   *      messages routed through the regular c2c slot.
   *   2. `messageBody.msgContent` carries the serialised
   *      `FileExtra { file: NotOnlineFile }` bytes. NOT
   *      `richText.notOnlineFile` — the receiver doesn't read that
   *      slot for file metadata.
   *   3. `contentHead.c2cCmd` left at 0 (Lagrange's default). The
   *      previous `c2cCmd: 11` was a stale go-cqhttp value the QQ-NT
   *      server doesn't recognise.
   *
   * NotOnlineFile carries three required-on-send fields the receiver
   * itself ignores but the server's intake validator checks:
   *   - `subcmd: 1`     — c2c file send command code
   *   - `dangerEvel: 0` — virus-scan severity, always 0 client-side
   *   - `expireTime`    — 7 days from now (Lagrange convention)
   */
  async sendC2cFileMessage(
    userUin: number,
    userUid: string,
    info: { fileId: string; fileName: string; fileSize: number; fileMd5: Uint8Array; fileHash?: string },
  ): Promise<SendMessageReceipt> {
    const random = this.nextMessageRandom();
    const clientSeq = this.nextClientSequence();

    const nowSec = Math.floor(Date.now() / 1000);
    const sevenDaysSec = 7 * 24 * 60 * 60;
    // Serialise `FileExtra { file: NotOnlineFile }` for `msgContent`.
    // The NotOnlineFile field tags (1/3/4/5/6/9/50/55/57) are shared
    // between send and receive — the schema is symmetric.
    const fileExtraBytes = protobuf_encode<FileExtra>({
      file: {
        fileType: 0,
        fileUuid: info.fileId,
        fileMd5: info.fileMd5,
        fileName: info.fileName,
        fileSize: BigInt(info.fileSize),
        subcmd: 1,
        dangerEvel: 0,
        expireTime: nowSec + sevenDaysSec,
        fileHash: info.fileHash ?? '',
      },
    });

    const request = protobuf_encode<SendMessageRequest>({
      routingHead: {
        // c2c-file scene: route through `trans0x211` (field 15) with
        // ccCmd=4. The regular `c2c { uin, uid }` routing slot causes
        // the server to reject this with a routing-mismatch error.
        trans0x211: { ccCmd: 4, uid: userUid },
      },
      contentHead: {
        type: 1,
        subType: 0,
        // c2cCmd intentionally omitted (defaults to 0). Was `11`,
        // which produced an unknown-command error in the QQ-NT
        // server's c2c file handler. `userUin` is unused on this path
        // (routing carries the uid only) but kept in the function
        // signature for symmetry with the OneBot caller.
      },
      messageBody: {
        // No elems — the file metadata lives in msgContent below.
        msgContent: fileExtraBytes,
      },
      clientSequence: clientSeq,
      random,
      syncCookie: new Uint8Array(0),
      via: 0,
      dataStatist: 0,
      ctrl: {
        msgFlag: nowSec,
      },
      multiSendSeq: 0,
    });

    // Silence the unused-parameter lint — `userUin` is part of our
    // BridgeInterface contract (the OneBot layer threads it through)
    // but the wire shape only needs the uid.
    void userUin;

    const result = await this.sendRawPacket(Bridge.SEND_MSG_CMD, request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send c2c file message failed: ${result.errorMessage || 'no response'}`);
    }

    const response = protobuf_decode<SendMessageResponse>(result.responseData);
    if (!response) {
      throw new Error('failed to decode SendMessageResponse');
    }
    if (response.result !== undefined && response.result !== 0) {
      throw new Error(`send c2c file message rejected: result=${response.result} err=${response.errMsg ?? ''}`);
    }

    const seq = response.privateSequence ?? 0;
    const messageId = (random & 0x7FFFFFFF) || seq;
    const timestamp = response.timestamp1 ?? Math.floor(Date.now() / 1000);
    return { messageId, sequence: seq, clientSequence: clientSeq, random, timestamp };
  }

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
  async recallGroupMessage(groupId: number, sequence: number): Promise<void> { return recallGroupMessage_(this, groupId, sequence); }
  async recallPrivateMessage(userUin: number, clientSeq: number, msgSeq: number, random: number, timestamp: number): Promise<void> { return recallPrivateMessage_(this, userUin, clientSeq, msgSeq, random, timestamp); }
  async markGroupMsgAsRead(groupId: number, sequence: number): Promise<void> { return markGroupMsgAsRead_(this, groupId, sequence); }
  async markPrivateMsgAsRead(userId: number, sequence: number): Promise<void> { return markPrivateMsgAsRead_(this, userId, sequence); }
  async setFriendRemark(userId: number, remark: string): Promise<void> { return setFriendRemark_(this, userId, remark); }
  async setGroupRemark(groupId: number, remark: string): Promise<void> { return setGroupRemark_(this, groupId, remark); }
  async getGroupHonorInfo(groupId: number, type: WebHonorType | string): Promise<any> {
    return getGroupHonorInfo_(this, groupId, type);
  }
  async forceFetchClientKey(): Promise<ClientKeyInfo> { return forceFetchClientKey_(this)}
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

