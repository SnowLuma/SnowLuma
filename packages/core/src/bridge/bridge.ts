// Bridge — per-UIN session: handler registration, packet dispatch, event routing.
// Supports packet sending via native addon.
// Heavy OIDB / contact / action logic is split into bridge-oidb, bridge-contacts, bridge-actions.

import type { PacketInfo } from '../protocol/types';
import type { ForwardNodePayload, QQEventVariant, MessageElement } from './events';
import type { FriendInfo, QQGroupInfo, GroupMemberInfo, UserProfileInfo, GroupRequestInfo } from './qq-info';
import { QQInfo } from './qq-info';
import { MSG_PUSH_CMD, parseMsgPush } from './handlers/msg-push-handler';
import type { PacketSender, SendPacketResult } from '../protocol/packet-sender';
import { protoEncode, protoDecode } from '../protobuf/decode';
import { buildSendElems } from './builders/element-builder';
import { createLogger } from '../utils/logger';
import {
  SendMessageRequestSchema,
  SendMessageResponseSchema,
} from './proto/action';

// Delegated modules
import { resolveUserUid as resolveUserUid_ } from './bridge-oidb';
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
  kickGroupMember as kickGroupMember_,
  kickGroupMembers as kickGroupMembers_,
  leaveGroup as leaveGroup_,
  setGroupAdmin as setGroupAdmin_,
  setGroupCard as setGroupCard_,
  setGroupName as setGroupName_,
  setGroupSpecialTitle as setGroupSpecialTitle_,
  setFriendAddRequest as setFriendAddRequest_,
  deleteFriend as deleteFriend_,
  uploadGroupFile as uploadGroupFile_,
  uploadPrivateFile as uploadPrivateFile_,
  fetchGroupFiles as fetchGroupFiles_,
  fetchGroupFileUrl as fetchGroupFileUrl_,
  fetchPrivateFileUrl as fetchPrivateFileUrl_,
  fetchGroupPttUrlByNode as fetchGroupPttUrlByNode_,
  fetchPrivatePttUrlByNode as fetchPrivatePttUrlByNode_,
  fetchGroupVideoUrlByNode as fetchGroupVideoUrlByNode_,
  fetchPrivateVideoUrlByNode as fetchPrivateVideoUrlByNode_,
  uploadForwardNodes as uploadForwardNodes_,
  fetchForwardNodes as fetchForwardNodes_,
  deleteGroupFile as deleteGroupFile_,
  moveGroupFile as moveGroupFile_,
  createGroupFileFolder as createGroupFileFolder_,
  deleteGroupFileFolder as deleteGroupFileFolder_,
  renameGroupFileFolder as renameGroupFileFolder_,
  setGroupAddRequest as setGroupAddRequest_,
  sendPoke as sendPoke_,
  sendLike as sendLike_,
  setGroupEssence as setGroupEssence_,
  setGroupReaction as setGroupReaction_,
  recallGroupMessage as recallGroupMessage_,
  recallPrivateMessage as recallPrivateMessage_,
  markPrivateMessageRead as markGroupMsgAsRead_,
  markGroupMessageRead as markPrivateMsgAsRead_,
  setFriendRemark as setFriendRemark_,
  setGroupRemark as setGroupRemark_,
  fetchGroupFileCount as fetchGroupFileCount_,
  setOnlineStatus as setOnlineStatus_,
  setProfile as setProfile_,
  getProfileLike as getProfileLike_,
  getGroupAtAllRemain as getGroupAtAllRemain_,
  getUnidirectionalFriendList as getUnidirectionalFriendList_,
  setSelfLongNick as setSelfLongNick_,
  setInputStatus as setInputStatus_,
  translateEn2Zh as translateEn2Zh_,
  getMiniAppArk as getMiniAppArk_,
  clickInlineKeyboardButton as clickInlineKeyboardButton_,
  sendGroupSign as sendGroupSign_,
  setAvatar as setAvatar_,
  fetchCustomFace as fetchCustomFace_,
  getEmojiLikes as getEmojiLikes_,
} from './bridge-actions';
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
} from './web-actions';
import type { GroupFilesResult } from './bridge-actions';
import type { MediaIndexNode } from './bridge-actions';
import { BridgeEventBus } from './event-bus';

type CmdParser = (pkt: PacketInfo, qqInfo: QQInfo) => QQEventVariant[];

export interface SendMessageReceipt {
  messageId: number;
  sequence: number;
  clientSequence: number;
  random: number;
  timestamp: number;
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

type GroupMemberIdentityEvent = Extract<QQEventVariant, { kind: 'group_member_join' | 'group_member_leave' }>;

const log = createLogger('Bridge');
const eventLog = createLogger('Event');

export class Bridge {
  private static readonly SEND_MSG_CMD = 'MessageSvc.PbSendMsg';

  private qqInfo_: QQInfo;
  private pids_ = new Set<number>();
  /**
   * Per-kind event subscription. Replaces the legacy single-callback
   * firehose: downstream consumers now register exactly the kinds they
   * care about and `emitEvent` fans out in parallel.
   */
  readonly events = new BridgeEventBus();
  private cmdHandlers_ = new Map<string, CmdParser[]>();
  private packetClient_: PacketSender | null = null;
  private memberRefreshTasks_ = new Map<number, Promise<void>>();
  // Throttle for fetchGroupMemberList(groupId): coalesces in-flight calls
  // and serves a fresh result for `kMemberListTtlMs` to all callers.
  // Without this, a busy OneBot client (e.g. MaiBot calling
  // get_group_member_info(no_cache=true) per inbound message) would
  // trigger one OIDB 0xfe7_3 per chat message per group; sustained rate
  // (>1k/h) is detected by Tencent risk-control and gets the account
  // banned for 7 days.
  private memberListInflight_ = new Map<number, Promise<GroupMemberInfo[]>>();
  private memberListLastFetch_ = new Map<number, { at: number; data: GroupMemberInfo[] }>();

  // Sequence and random generators for outgoing messages
  private clientSeq_ = 100000000 + (Date.now() % 1000000000);
  private msgRandom_ = (Date.now() & 0xFFFFFFFF) >>> 0;

  constructor(qqInfo: QQInfo) {
    this.qqInfo_ = qqInfo;
    this.registerDefaultHandlers();
  }

  get qqInfo(): QQInfo { return this.qqInfo_; }

  setPacketClient(client: PacketSender): void {
    this.packetClient_ = client;
  }

  private registerDefaultHandlers(): void {
    this.registerCmd(MSG_PUSH_CMD, parseMsgPush);
  }

  registerCmd(cmd: string, parser: CmdParser): void {
    const arr = this.cmdHandlers_.get(cmd) ?? [];
    arr.push(parser);
    this.cmdHandlers_.set(cmd, arr);
  }

  handlesCmd(cmd: string): boolean {
    return this.cmdHandlers_.has(cmd);
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
    const handlers = this.cmdHandlers_.get(pkt.serviceCmd);
    if (!handlers) return;

    for (const handler of handlers) {
      try {
        const events = handler(pkt, this.qqInfo_);
        for (const event of events) {
          if (this.needsPreDispatchIdentityRefresh(event)) {
            void this.dispatchAfterIdentityRefresh(event);
          } else {
            this.triggerMemberCacheRefresh(event);
            printEvent(event);
            this.emitEvent(event);
          }
        }
      } catch (e) {
        log.error('handler error for %s: %s', pkt.serviceCmd, e instanceof Error ? (e.stack ?? e.message) : String(e));
      }
    }
  }

  private needsPreDispatchIdentityRefresh(event: QQEventVariant): event is Extract<QQEventVariant, { kind: 'group_member_join' }> {
    return event.kind === 'group_member_join' && event.groupId > 0 && event.userUin <= 0 && Boolean(event.userUid);
  }

  private async dispatchAfterIdentityRefresh(event: Extract<QQEventVariant, { kind: 'group_member_join' }>): Promise<void> {
    let refreshed = false;
    try {
      refreshed = await this.prepareGroupMemberJoinIdentity(event);
    } catch (e) {
      log.warn('failed to resolve group member join identity: group=%d uid=%s err=%s',
        event.groupId, event.userUid ?? '', e instanceof Error ? e.message : String(e));
    }

    this.triggerMemberCacheRefresh(event, refreshed);
    printEvent(event);
    this.emitEvent(event);
  }

  private emitEvent(event: QQEventVariant): void {
    // Fire-and-forget: errors inside subscribers are surfaced via the bus's
    // own onError hook so one bad listener never blocks the others.
    void this.events.emit(event);
  }

  private async prepareGroupMemberJoinIdentity(event: Extract<QQEventVariant, { kind: 'group_member_join' }>): Promise<boolean> {
    this.resolveMemberIdentityFromCache(event);
    if (event.userUin > 0 || !event.userUid || event.groupId <= 0) return false;

    const refreshed = await this.refreshMemberCache(
      event.groupId,
      !this.qqInfo_.findGroup(event.groupId) || this.isSelfMemberIdentity(event.userUin, event.userUid),
      true,
    );
    this.resolveMemberIdentityFromCache(event);
    return refreshed;
  }

  private resolveMemberIdentityFromCache(event: GroupMemberIdentityEvent): void {
    if (event.groupId <= 0) return;
    if (event.userUin <= 0 && event.userUid) {
      const uin = this.resolveUidFromCache(event.groupId, event.userUid);
      if (uin !== null) event.userUin = uin;
    }
    if (event.operatorUin <= 0 && event.operatorUid) {
      const uin = this.resolveUidFromCache(event.groupId, event.operatorUid);
      if (uin !== null) event.operatorUin = uin;
    }
  }

  private resolveUidFromCache(groupId: number, uid: string): number | null {
    return this.qqInfo_.resolveGroupMemberUid(groupId, uid) ?? this.qqInfo_.resolveUid(uid);
  }

  private isSelfMemberIdentity(uin: number, uid?: string): boolean {
    const selfUin = Number(this.qqInfo_.uin);
    return (uin > 0 && uin === selfUin) || (Boolean(uid) && uid === this.qqInfo_.selfUid);
  }

  private triggerMemberCacheRefresh(event: QQEventVariant, alreadyRefreshed = false): void {
    if (alreadyRefreshed) return;

    let groupId = 0;
    let reason = '';
    let refreshGroupList = false;
    switch (event.kind) {
      case 'group_member_join':
        groupId = event.groupId;
        reason = 'group_member_join';
        refreshGroupList = this.isSelfMemberIdentity(event.userUin, event.userUid);
        break;
      case 'group_member_leave':
        groupId = event.groupId;
        reason = 'group_member_leave';
        break;
      case 'group_admin':
        groupId = event.groupId;
        reason = 'group_admin';
        break;
      default:
        return;
    }

    if (groupId <= 0) return;
    if (this.memberRefreshTasks_.has(groupId)) return;
    if (event.kind === 'group_member_join' && !this.qqInfo_.findGroup(groupId)) {
      refreshGroupList = true;
    }

    const task = (async () => {
      try {
        await this.refreshMemberCache(groupId, refreshGroupList, false);
        log.debug('member cache refreshed: group=%d reason=%s', groupId, reason);
      } catch (e) {
        log.warn('failed to refresh member cache: group=%d reason=%s err=%s',
          groupId, reason, e instanceof Error ? e.message : String(e));
      } finally {
        this.memberRefreshTasks_.delete(groupId);
      }
    })();

    this.memberRefreshTasks_.set(groupId, task);
  }

  private async refreshMemberCache(groupId: number, refreshGroupList: boolean, forceMemberList: boolean): Promise<boolean> {
    if (refreshGroupList) {
      try { await this.fetchGroupList(); } catch { /* ignore */ }
    }
    if (!this.qqInfo_.findGroup(groupId)) return false;
    await this.fetchGroupMemberList(groupId, { force: forceMemberList });
    return true;
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

    const request = protoEncode({
      routingHead: {
        grp: { groupCode: BigInt(groupId) },
      } as any,
      contentHead: {
        type: 1,
      } as any,
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
    }, SendMessageRequestSchema);

    const result = await this.sendRawPacket(Bridge.SEND_MSG_CMD, request);

    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send group message failed: ${result.errorMessage || 'no response'}`);
    }

    const response = protoDecode(result.responseData, SendMessageResponseSchema);
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

    // Resolve UID for image upload (C++ resolves UID before building elems)
    let userUid = '';
    const hasMedia = elements.some(e => e.type === 'image' || e.type === 'record' || e.type === 'video');
    if (hasMedia) {
      userUid = await this.resolveUserUid(userUin);
    }

    const protoElems = await buildSendElems(elements, { bridge: this, userUid });
    const random = this.nextMessageRandom();
    const clientSeq = this.nextClientSequence();

    const request = protoEncode({
      routingHead: {
        c2c: {
          uin: userUin,
        },
      } as any,
      contentHead: {
        type: 1,
        subType: 0,
        c2cCmd: 11,
      } as any,
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
      } as any,
      multiSendSeq: 0,
    }, SendMessageRequestSchema);

    const result = await this.sendRawPacket(Bridge.SEND_MSG_CMD, request);

    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(`send private message failed: ${result.errorMessage || 'no response'}`);
    }

    const response = protoDecode(result.responseData, SendMessageResponseSchema);
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

  // --- Delegated: OIDB helpers ---

  async resolveUserUid(uin: number, groupId?: number): Promise<string> {
    return resolveUserUid_(this, uin, groupId);
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
  async fetchGroupFiles(groupId: number, folderId = '/'): Promise<GroupFilesResult> { return fetchGroupFiles_(this, groupId, folderId); }
  async fetchGroupFileUrl(groupId: number, fileId: string, busId = 102): Promise<string> { return fetchGroupFileUrl_(this, groupId, fileId, busId); }
  async fetchPrivateFileUrl(userId: number, fileId: string, fileHash: string): Promise<string> { return fetchPrivateFileUrl_(this, userId, fileId, fileHash); }
  async fetchGroupPttUrlByNode(groupId: number, node: MediaIndexNode): Promise<string> { return fetchGroupPttUrlByNode_(this, groupId, node); }
  async fetchPrivatePttUrlByNode(node: MediaIndexNode): Promise<string> { return fetchPrivatePttUrlByNode_(this, node); }
  async fetchGroupVideoUrlByNode(groupId: number, node: MediaIndexNode): Promise<string> { return fetchGroupVideoUrlByNode_(this, groupId, node); }
  async fetchPrivateVideoUrlByNode(node: MediaIndexNode): Promise<string> { return fetchPrivateVideoUrlByNode_(this, node); }
  async uploadForwardNodes(nodes: ForwardNodePayload[], groupId?: number): Promise<string> { return uploadForwardNodes_(this, nodes, groupId); }
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
  async fetchCustomFace(count?: number): Promise<string[]> {
    return fetchCustomFace_(this, count);
  }
  async getEmojiLikes(groupId: number, sequence: number, emojiId: string, emojiType?: number, count?: number, cookie?: string) {
    return getEmojiLikes_(this, groupId, sequence, emojiId, emojiType, count, cookie);
  }
}

// --- Module-level helper functions ---

function elementsToText(elements: MessageElement[]): string {
  return elements.map(e => {
    switch (e.type) {
      case 'text': return e.text ?? '';
      case 'at': return `@${e.targetUin ?? 'all'}`;
      case 'face': return `[表情:${e.faceId}]`;
      case 'mface': return `[${e.summary ?? '表情'}]`;
      case 'image': return '[图片]';
      case 'video': return '[视频]';
      case 'record': return '[语音]';
      case 'file': return `[文件:${e.fileName ?? ''}]`;
      case 'json': return '[JSON卡片]';
      case 'xml': return '[XML卡片]';
      case 'reply': return `[回复:${e.replySeq}]`;
      case 'poke': return '[戳一戳]';
      case 'forward': return '[合并转发]';
      case 'markdown': return '[Markdown]';
      default: return `[${e.type}]`;
    }
  }).join('');
}

function formatEventUser(uin: number, uid?: string): string {
  if (uin > 0) return String(uin);
  return uid || '未知用户';
}

function printEvent(event: QQEventVariant): void {
  switch (event.kind) {
    case 'group_message':
    case 'friend_message':
    case 'temp_message':
      // Message logging is handled by OneBot layer with message ID
      break;
    case 'group_recall':
      eventLog.warn('群撤回 %d | %d 被 %d 撤回', event.groupId, event.authorUin, event.operatorUin);
      break;
    case 'friend_recall':
      eventLog.warn('私聊撤回 %d 撤回了消息', event.userUin);
      break;
    case 'group_member_join':
      eventLog.info('入群 %s 加入 %d', formatEventUser(event.userUin, event.userUid), event.groupId);
      break;
    case 'group_member_leave':
      eventLog.warn('退群 %s %s %d', formatEventUser(event.userUin, event.userUid), event.isKick ? '被踢出' : '退出', event.groupId);
      break;
    case 'group_mute':
      eventLog.warn('禁言 %d | %d %d秒', event.groupId, event.userUin, event.duration);
      break;
    case 'group_admin':
      eventLog.info('管理 %d | %d %s管理员', event.groupId, event.userUin, event.set ? '+' : '-');
      break;
    case 'friend_poke':
      eventLog.info('戳一戳 %d -> %d', event.userUin, event.targetUin);
      break;
    case 'group_poke':
      eventLog.info('群戳 %d | %d -> %d', event.groupId, event.userUin, event.targetUin);
      break;
    case 'friend_request':
      eventLog.warn('好友请求 %d: %s', event.fromUin, event.message);
      break;
    case 'group_invite':
      eventLog.warn('群邀请 %d -> 群%d', event.fromUin, event.groupId);
      break;
    case 'group_essence':
      eventLog.info('精华 %d | %s精华', event.groupId, event.set ? '+' : '-');
      break;
  }
}
