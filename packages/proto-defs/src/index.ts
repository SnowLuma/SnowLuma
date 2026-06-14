// SnowLuma wire-protobuf type definitions.
//
// This barrel exists so `@snowluma/proto-defs` can be resolved by a
// plain `import {} from '@snowluma/proto-defs'` (consumers that don't
// know which sub-namespace they want, or just want to see what's
// available). The package itself is otherwise consumed via the
// per-file subpath exports declared in package.json — that's the
// recommended import shape because it mirrors the legacy
// `bridge/proto/proton/<sub>` paths 1:1 and avoids name collisions.
//
// ─── Collision note ───
//
// `highway.ts` and `oidb-actions/media.ts` each define their own
// `NTV2*` types (NTV2CommonHead, NTV2ClientMeta, NTV2C2CUserInfo,
// NTV2FileInfo, NTV2FileType, NTV2GroupInfo). The two definitions
// are NOT compatible — they describe different wire shapes for
// different protocol surfaces and happen to share the same name in
// the upstream Lagrange schema. `export *` silently drops one side
// when names collide, so a consumer that grabs an `NTV2CommonHead`
// off the barrel might end up with the wrong one. Prefer the subpath
// imports below for any NTV2-named type.

export type * from './action.js';
export type * from './element.js';
// NOTE: `highway.ts` intentionally NOT re-exported here — see note above.
export type * from './longmsg.js';
export type * from './message.js';
export type * from './get-group-msg.js';
export type * from './get-c2c-msg.js';
export type * from './notify.js';
export type * from './oidb.js';
export type * from './oidb-action.js';
export type * from './oidb-actions/base.js';
export type * from './oidb-actions/group-album.js';
export type * from './oidb-actions/group-file.js';
// NOTE: `oidb-actions/media.ts` intentionally NOT re-exported — see note above.
