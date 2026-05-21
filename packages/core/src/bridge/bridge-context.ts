// Api-layer extension of @snowluma/bridge's slim BridgeContext.
//
// The slim interface in @snowluma/bridge has the protocol-layer
// surface (identity / events / sendRawPacket / resolveUserUid / next*
// sequence helpers / upload-metadata cache). This file extends it
// with `apis: ApiHub` — the typed bag of Api classes that lives ONLY
// in @snowluma/core, so the bridge package never sees it (avoiding
// a bridge → core cycle).
//
// The 13 Api classes (apis/<area>.ts) import `BridgeContext` from
// here, which gives them `this.ctx.apis.message.sendGroup(...)` type-
// safety alongside the protocol-layer fields. Highway uploaders,
// element-builder, msg-push parsers (all in @snowluma/bridge) import
// the slim version directly from `@snowluma/bridge/bridge-context`.

import type { BridgeContext as BaseBridgeContext } from '@snowluma/bridge/bridge-context';
import type { ApiHub } from './apis';

export interface BridgeContext extends BaseBridgeContext {
  readonly apis: ApiHub;
}

// Re-export `UploadedFileMeta` from the slim package so existing
// `import type { UploadedFileMeta } from '<…>/bridge-context'` (or
// from bridge.ts via re-export) keeps working without callers having
// to learn the new package path.
export type { UploadedFileMeta } from '@snowluma/bridge/bridge-context';
