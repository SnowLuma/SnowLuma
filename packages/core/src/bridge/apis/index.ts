import type { BridgeContext } from '../bridge-context';
import { ContactsApi } from './contacts';
import { ExtrasApi } from './extras';
import { FlashTransferApi } from './flash-transfer';
import { ForwardApi } from './forward';
import { FriendApi } from './friend';
import { GroupAdminApi } from './group-admin';
import { GroupAlbumApi } from './group-album';
import { GroupFileApi } from './group-file';
import { InteractionApi } from './interaction';
import { MessageApi } from './message';
import { MiscApi } from './misc';
import { ProfileApi } from './profile';
import { QzoneApi } from './qzone';
import { WebApi } from './web';

export interface ApiHub {
  /** Send/recall/markRead operations across c2c + group + c2c-file. */
  readonly message: MessageApi;
  /** Friend / group / member roster + user-profile + group-request-list + download-rkey. */
  readonly contacts: ContactsApi;
  /** Group moderation: mute/kick/admin/card/name/title/leave + join-policy. */
  readonly groupAdmin: GroupAdminApi;
  /** Group file CRUD + private (c2c) file upload + media URL resolvers. */
  readonly groupFile: GroupFileApi;
  /** Group photo album: list/upload/comment/like/delete + media listing. */
  readonly groupAlbum: GroupAlbumApi;
  /** Personal QQ-Zone (个人空间): 说说 list + (future) publish/like/comment. */
  readonly qzone: QzoneApi;
  /** Interactive engagement: poke / like / reaction / essence / emoji-like-list. */
  readonly interaction: InteractionApi;
  /** Friend roster mutations: handleRequest / delete / setRemark. */
  readonly friend: FriendApi;
  /** Personal profile: status / avatar / nickname / likes / custom-faces. */
  readonly profile: ProfileApi;
  /** QQ 闪传（fileset 文件集）: 上传/查询/分享/发送/删除/重命名。 */
  readonly flashTransfer: FlashTransferApi;
  /** Long-message (forward / 聊天记录) upload + retrieval with NapCat piggyback. */
  readonly forward: ForwardApi;
  /** Odds & ends: translate / mini-app ARK / inline-keyboard / group sign. */
  readonly misc: MiscApi;
  /** Tier-2 napcat-parity: group todo / stranger status / AI voice. */
  readonly extras: ExtrasApi;
  /** Cookie-backed HTTP: essence / honor / notice / client-key / csrf-token. */
  readonly web: WebApi;
}

/**
 * Construct the ApiHub for a Bridge. Called once from the Bridge
 * constructor. Eager construction means every Bridge instance pays
 * the cost up-front (a few object allocations) — there's no lazy
 * path because that would require either a thunk-based wrapper or
 * runtime-mutated `apis.xxx` slots, neither of which is worth the
 * complexity for ~13 small classes.
 */
export function buildApiHub(ctx: BridgeContext): ApiHub {
  return {
    message: new MessageApi(ctx),
    contacts: new ContactsApi(ctx),
    groupAdmin: new GroupAdminApi(ctx),
    groupFile: new GroupFileApi(ctx),
    groupAlbum: new GroupAlbumApi(ctx),
    qzone: new QzoneApi(ctx),
    interaction: new InteractionApi(ctx),
    friend: new FriendApi(ctx),
    profile: new ProfileApi(ctx),
    flashTransfer: new FlashTransferApi(ctx),
    forward: new ForwardApi(ctx),
    misc: new MiscApi(ctx),
    extras: new ExtrasApi(ctx),
    web: new WebApi(ctx),
  };
}

// Re-export the Api classes themselves so callers can write
// `import type { MessageApi } from '@snowluma/core/.../apis'` for
// signature use. Concrete instances always come from `bridge.apis.*`.
export { ContactsApi } from './contacts';
export { ExtrasApi } from './extras';
export { ForwardApi } from './forward';
export { FriendApi } from './friend';
export { GroupAdminApi } from './group-admin';
export { GroupAlbumApi } from './group-album';
export { GroupFileApi } from './group-file';
export { InteractionApi } from './interaction';
export { MessageApi } from './message';
export { MiscApi } from './misc';
export { ProfileApi } from './profile';
export { QzoneApi } from './qzone';
export { FlashTransferApi, type FlashFileInfo } from './flash-transfer';
export { WebApi } from './web';

