// ApiHub — the per-instance bag of typed Api classes hanging off
// `bridge.apis`. Mirrors NapCat's `NapCatCore.apis = { MsgApi, …}`
// pattern but uses camelCase keys (`apis.message.sendGroup`) to match
// the rest of the SnowLuma TypeScript style.
//
// Each Api class is constructed once when the parent `Bridge` is
// constructed (eager — every account that connects gets its own
// `apis.*` set immediately). Api classes receive a `BridgeContext`
// reference, NOT the concrete `Bridge`, so they remain easy to mock
// without standing up a full Bridge instance.
//
// Adding a new Api:
//   1. Create `bridge/apis/<name>.ts` exporting a `class XxxApi`.
//   2. Add a property here.
//   3. Construct it inside `buildApiHub(ctx)` below.
//   4. Move the relevant methods OFF Bridge and onto the new Api.
//
// This file evolves commit-by-commit as `#6 NapCat-style Api on ctx`
// lands the 13 areas. Until all 13 are in place, ApiHub will have a
// mix of "done" entries and "TODO" markers below — the TODO list
// shrinks as each commit lands.

import type { BridgeContext } from '../bridge-context';
import { ContactsApi } from './contacts';
import { GroupAdminApi } from './group-admin';
import { GroupAlbumApi } from './group-album';
import { GroupFileApi } from './group-file';
import { MessageApi } from './message';

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
  // Pending — added as later commits land:
  //   readonly friend:      FriendApi;
  //   readonly interaction: InteractionApi;
  //   readonly profile:     ProfileApi;
  //   readonly forward:     ForwardApi;
  //   readonly misc:        MiscApi;
  //   readonly extras:      ExtrasApi;
  //   readonly web:         WebApi;
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
  };
}

// Re-export the Api classes themselves so callers can write
// `import type { MessageApi } from '@snowluma/core/.../apis'` for
// signature use. Concrete instances always come from `bridge.apis.*`.
export { ContactsApi } from './contacts';
export { GroupAdminApi } from './group-admin';
export { GroupAlbumApi } from './group-album';
export { GroupFileApi } from './group-file';
export { MessageApi } from './message';
