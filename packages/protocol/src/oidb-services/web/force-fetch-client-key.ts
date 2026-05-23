// 0x102A_1 — fetch a fresh `clientKey` (consumed by the ptlogin2 jump
// URL flow that swaps it for cookie-jar entries on qq.com subdomains).
//
// The server's `keyIndex` field is occasionally empty in the wild;
// every NapCat-derived implementation falls back to the literal "19"
// in that case — origin unknown but the value works.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbClientKeyReq, OidbClientKeyResp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface ClientKeyInfo {
  clientKey: string;
  keyIndex: string;
  expireTime: string;
}

export namespace ForceFetchClientKey {
  export const command = 0x102A;
  export const subCommand = 1;

  export interface Params {}

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, _: Params): OidbClientKeyReq => ({});

  export const deserialize = (_ctx: Deps, body: OidbClientKeyResp): ClientKeyInfo => ({
    clientKey: body.clientKey || '',
    keyIndex: String(body.keyIndex || '19'),
    expireTime: String(body.expireTime || '1800'),
  });

  export const encode = (env: OidbBase<OidbClientKeyReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbClientKeyReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbClientKeyResp> =>
    protobuf_decode<OidbBase<OidbClientKeyResp>>(bytes);

  export const invoke = (deps: Deps): Promise<ClientKeyInfo> =>
    invokeOidb(deps, ForceFetchClientKey, {});
}
