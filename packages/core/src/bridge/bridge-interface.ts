import type { SendPacketResult } from '../protocol/packet-sender';
import type { ApiHub } from './apis';
import type {
  ClientKeyInfo,
  DownloadRKeyInfo,
  UploadedFileMeta,
} from './bridge';
import type { BridgeEventBus } from './event-bus';
import type { IdentityService } from './identity-service';
import type { WebHonorType } from './web/group-honor';

export interface BridgeInterface {
  // ─── Shared state ───
  readonly identity: IdentityService;
  readonly events: BridgeEventBus;
  readonly activePid: number | null;
  /**
   * Typed Api hub — `apis.message.sendGroup(...)`, `apis.message.recallGroup(...)`,
   * etc. The shape of `ApiHub` grows commit-by-commit as the #6
   * refactor moves the remaining areas (group-admin, group-file,
   * profile, …) off Bridge and onto their dedicated Api classes.
   */
  readonly apis: ApiHub;

  // ─── Resolution ───
  resolveUserUid(uin: number, groupId?: number): Promise<string>;

  // ─── Raw packet (deliberate escape hatch for `send_packet` action) ───
  // OneBot clients use this to debug or invoke commands SnowLuma has no
  // typed wrapper for. Every other method on this interface eventually
  // routes through here.
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;

  // ─── Send-side protocol helpers (used by Api classes) ───
  nextMessageRandom(): number;
  nextClientSequence(): number;

  // ─── Send (messages) ───
  //   Moved to `apis.message.{sendGroup, sendPrivate, sendC2cFile,
  //   recallGroup, recallPrivate, markGroupRead, markPrivateRead}`.

  // ─── Fetch (contacts / profile / system) — moved to apis.contacts ───

  // ─── Group admin (moved to apis.groupAdmin) ───
  // ─── Group reaction / essence (moved to apis.interaction) ───

  // ─── Friend (moved to apis.friend) ───
  //   - handleRequest / delete / setRemark

  // ─── Files (moved to apis.groupFile) ───
  //   - upload / uploadPrivate / publish
  //   - list / getCount
  //   - getUrl / getPrivateUrl / getPttUrl / getPrivatePttUrl
  //   - getVideoUrl / getPrivateVideoUrl
  //   - delete / move / createFolder / deleteFolder / renameFolder
  /** Cache file metadata so a later send_msg with just `file_id` can rehydrate it. */
  rememberUploadedFile(meta: UploadedFileMeta): void;
  recallUploadedFile(fileId: string): UploadedFileMeta | undefined;

  // ─── Group Album (moved to apis.groupAlbum) ───
  //   - list / upload / getMediaList / comment / like / delete

  // ─── Forward (moved to apis.forward) ───
  //   - upload / fetch

  // ─── Message ops (moved to apis.message) ───

  // ─── Interaction (moved to apis.interaction) ───
  //   - sendPoke / sendLike / setReaction / setEssence / getEmojiLikes

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

  // ─── Personal profile (moved to apis.profile) ───
  //   - setOnlineStatus / setDiyOnlineStatus
  //   - setProfile / setSelfLongNick / setInputStatus
  //   - setAvatar / setGroupAvatar / fetchCustomFace
  //   - getLike / getUnidirectionalFriendList

  // ─── Misc (moved to apis.misc) ───
  //   - translateEn2Zh / getMiniAppArk / clickInlineKeyboardButton / sendGroupSign

  // ─── Tier-2 napcat parity extras (moved to apis.extras) ───
  //   - setGroupTodo / completeGroupTodo / cancelGroupTodo
  //   - getStrangerStatus
  //   - fetchAiVoiceList / fetchAiVoice
}
