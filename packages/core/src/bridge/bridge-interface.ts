// BridgeInterface — the surface OneBot (and any other external consumer)
// is allowed to see. The concrete Bridge class additionally exposes raw
// protocol primitives (sendRawPacket, packet dispatch, PID management)
// used by the in-tree action / contacts / highway modules; those internal
// methods deliberately do NOT appear here so that callers depending on
// the interface stay decoupled from the wire format.
//
// Every method below has a matching signature on Bridge; `Bridge
// implements BridgeInterface` is the compile-time enforcement.

import type { BridgeEventBus } from './event-bus';
import type { IdentityService } from './identity-service';
import type {
  FriendInfo, QQGroupInfo, GroupMemberInfo,
  UserProfileInfo, GroupRequestInfo,
} from './qq-info';
import type { MessageElement, ForwardNodePayload } from './events';
import type { GroupFilesResult } from './actions/group-file';
import type { MediaIndexNode } from './actions/shared';
import type { WebHonorType } from './web/group-honor';
import type {
  SendMessageReceipt,
  DownloadRKeyInfo,
  ClientKeyInfo,
} from './bridge';
import type { SendPacketResult } from '../protocol/packet-sender';

export interface BridgeInterface {
  // ─── Shared state ───
  readonly identity: IdentityService;
  readonly events: BridgeEventBus;
  readonly activePid: number | null;

  // ─── Resolution ───
  resolveUserUid(uin: number, groupId?: number): Promise<string>;

  // ─── Raw packet (deliberate escape hatch for `send_packet` action) ───
  // OneBot clients use this to debug or invoke commands SnowLuma has no
  // typed wrapper for. Every other method on this interface eventually
  // routes through here.
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;

  // ─── Send (messages) ───
  sendGroupMessage(groupId: number, elements: MessageElement[]): Promise<SendMessageReceipt>;
  sendPrivateMessage(userUin: number, elements: MessageElement[]): Promise<SendMessageReceipt>;

  // ─── Fetch (contacts / profile / system) ───
  fetchFriendList(): Promise<FriendInfo[]>;
  fetchGroupList(): Promise<QQGroupInfo[]>;
  fetchGroupMemberList(groupId: number, options?: { force?: boolean }): Promise<GroupMemberInfo[]>;
  fetchUserProfile(uin: number): Promise<UserProfileInfo>;
  fetchGroupRequests(filtered?: boolean): Promise<GroupRequestInfo[]>;
  fetchDownloadRKeys(): Promise<DownloadRKeyInfo[]>;

  // ─── Group admin ───
  muteGroupMember(groupId: number, userId: number, duration: number): Promise<void>;
  muteGroupAll(groupId: number, enable: boolean): Promise<void>;
  setGroupAddOption(groupId: number, addType: number): Promise<void>;
  setGroupSearch(groupId: number): Promise<void>;
  setGroupAddRequest(groupId: number, sequence: number, eventType: number, approve: boolean, reason?: string, filtered?: boolean): Promise<void>;
  kickGroupMember(groupId: number, userId: number, reject: boolean, reason?: string): Promise<void>;
  kickGroupMembers(groupId: number, userIds: number[], reject: boolean): Promise<void>;
  leaveGroup(groupId: number): Promise<void>;
  setGroupAdmin(groupId: number, userId: number, enable: boolean): Promise<void>;
  setGroupCard(groupId: number, userId: number, card: string): Promise<void>;
  setGroupName(groupId: number, name: string): Promise<void>;
  setGroupSpecialTitle(groupId: number, userId: number, title: string): Promise<void>;
  setGroupRemark(groupId: number, remark: string): Promise<void>;
  setGroupReaction(groupId: number, sequence: number, code: string, isSet: boolean): Promise<void>;
  setGroupEssence(groupId: number, sequence: number, random: number, enable: boolean): Promise<void>;

  // ─── Friend ───
  setFriendAddRequest(uidOrFlag: string, approve: boolean): Promise<void>;
  deleteFriend(userId: number, block?: boolean): Promise<void>;
  setFriendRemark(userId: number, remark: string): Promise<void>;

  // ─── Files ───
  uploadGroupFile(groupId: number, file: string, name?: string, folderId?: string, uploadFile?: boolean): Promise<{ fileId: string | null }>;
  uploadPrivateFile(userId: number, file: string, name?: string, uploadFile?: boolean): Promise<{ fileId: string | null }>;
  fetchGroupFiles(groupId: number, folderId?: string): Promise<GroupFilesResult>;
  fetchGroupFileUrl(groupId: number, fileId: string, busId?: number): Promise<string>;
  fetchPrivateFileUrl(userId: number, fileId: string, fileHash: string): Promise<string>;
  fetchGroupPttUrlByNode(groupId: number, node: MediaIndexNode): Promise<string>;
  fetchPrivatePttUrlByNode(node: MediaIndexNode): Promise<string>;
  fetchGroupVideoUrlByNode(groupId: number, node: MediaIndexNode): Promise<string>;
  fetchPrivateVideoUrlByNode(node: MediaIndexNode): Promise<string>;
  deleteGroupFile(groupId: number, fileId: string): Promise<void>;
  moveGroupFile(groupId: number, fileId: string, parentDirectory: string, targetDirectory: string): Promise<void>;
  createGroupFileFolder(groupId: number, name: string, parentId?: string): Promise<void>;
  deleteGroupFileFolder(groupId: number, folderId: string): Promise<void>;
  renameGroupFileFolder(groupId: number, folderId: string, newFolderName: string): Promise<void>;
  fetchGroupFileCount(groupId: number): Promise<{ fileCount: number; maxCount: number }>;

  // ─── Forward ───
  uploadForwardNodes(nodes: ForwardNodePayload[], groupId?: number): Promise<string>;
  fetchForwardNodes(resId: string): Promise<ForwardNodePayload[]>;

  // ─── Message ops ───
  recallGroupMessage(groupId: number, sequence: number): Promise<void>;
  recallPrivateMessage(userUin: number, clientSeq: number, msgSeq: number, random: number, timestamp: number): Promise<void>;
  markGroupMsgAsRead(groupId: number, sequence: number): Promise<void>;
  markPrivateMsgAsRead(userId: number, sequence: number): Promise<void>;

  // ─── Interaction ───
  sendPoke(isGroup: boolean, peerUin: number, targetUin?: number): Promise<void>;
  sendLike(userId: number, count: number): Promise<void>;
  getEmojiLikes(groupId: number, sequence: number, emojiId: string, emojiType?: number, count?: number, cookie?: string): Promise<{ users: Array<{ uin: number }>; cookie: string; isLast: boolean }>;

  // ─── Web-backed ───
  getGroupHonorInfo(groupId: number, type: WebHonorType | string): Promise<any>;
  forceFetchClientKey(): Promise<ClientKeyInfo>;
  getGroupEssence(groupId: number, pageStart?: number, pageLimit?: number): Promise<any>;
  getGroupEssenceAll(groupId: number): Promise<any>;
  sendGroupNotice(groupId: number, content: string, options?: any): Promise<any>;
  getGroupNotice(groupId: number): Promise<any>;
  deleteGroupNotice(groupId: number, fid: string): Promise<boolean>;
  getCookiesStr(domain: string): Promise<string>;
  getCsrfToken(): Promise<number>;
  getCredentials(domain: string): Promise<any>;

  // ─── Personal profile ───
  setOnlineStatus(status: number, extStatus?: number, batteryStatus?: number): Promise<void>;
  setDiyOnlineStatus(faceId: number, wording: string, faceType: number): Promise<void>;
  setProfile(nickname?: string, personalNote?: string): Promise<void>;
  setSelfLongNick(longNick: string): Promise<any>;
  setInputStatus(userId: number, eventType: number): Promise<any>;
  setAvatar(source: string): Promise<void>;
  fetchCustomFace(count?: number): Promise<string[]>;
  getProfileLike(userId?: number, start?: number, limit?: number): Promise<any>;
  getUnidirectionalFriendList(): Promise<any>;
  getGroupAtAllRemain(groupId: number): Promise<any>;

  // ─── Misc ───
  translateEn2Zh(words: string[]): Promise<any>;
  getMiniAppArk(type: string, title: string, desc: string, picUrl: string, jumpUrl: string): Promise<any>;
  clickInlineKeyboardButton(groupId: number, botAppid: number, buttonId: string, callbackData: string, msgSeq: number): Promise<any>;
  sendGroupSign(groupId: number): Promise<any>;

  // ─── Tier-2 napcat parity extras ───
  setGroupTodo(groupId: number, msgSeq: bigint | number | string): Promise<void>;
  completeGroupTodo(groupId: number, msgSeq: bigint | number | string): Promise<void>;
  cancelGroupTodo(groupId: number, msgSeq: bigint | number | string): Promise<void>;
  getStrangerStatus(uin: number): Promise<{ status: number; ext_status: number } | null>;
  fetchAiVoiceList(groupId: number, chatType: number): Promise<Array<{ category: string; voices: Array<{ voiceId: string; voiceDisplayName: string; voiceExampleUrl: string }> }>>;
  fetchAiVoice(groupId: number, voiceId: string, text: string, chatType: number): Promise<MediaIndexNode>;
}
