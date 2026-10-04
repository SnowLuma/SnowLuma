import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbFetchSysFaceReq, OidbFetchSysFaceResp } from '@snowluma/proto-defs/oidb-actions/sys-faces';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { emojiToEntry, type SysFaceEntry } from './fetch-sys-faces';

/** Resolve metadata for a system face that is absent from the visible panels. */
export namespace FetchSysFace {
  export const command = 0x9155;
  export const subCommand = 1;
  export interface Params { faceId: number }
  export type Deps = OidbSender;
  export const serialize = (_ctx: Deps, p: Params): OidbFetchSysFaceReq => ({ qSid: String(p.faceId) });
  export const deserialize = (_ctx: Deps, body: OidbFetchSysFaceResp): SysFaceEntry | null => {
    if (!body.emoji) return null;
    const entry = emojiToEntry(body.emoji, { source: 'single', packIndex: 0, faceIndex: 0 });
    if (!entry) throw new Error('system face lookup response is missing its id');
    return entry;
  };
  export const encode = (env: OidbBase<OidbFetchSysFaceReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbFetchSysFaceReq>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbFetchSysFaceResp> =>
    protobuf_decode<OidbBase<OidbFetchSysFaceResp>>(bytes);
  export const invoke = (deps: Deps, params: Params): Promise<SysFaceEntry | null> =>
    invokeOidb(deps, FetchSysFace, params);
}
