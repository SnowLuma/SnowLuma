// 0xE17_0 — fetch the unidirectional friend block list. Wire name is
// non-standard (`MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0`) — uses
// the `wireName` override to bypass the default
// `OidbSvcTrpcTcp.0xNNNN_N` scheme.
//
// Request and response carry a JSON-encoded string in a single
// protobuf field, so the namespace's `serialize` / `deserialize` do
// the JSON marshalling.

import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xe17Req, Oidb0xe17Resp } from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '../../bridge-context';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface UnidirectionalFriendEntry {
  [key: string]: import('@snowluma/common/json').JsonValue;
}

export namespace GetUnidirectionalFriendList {
  export const command = 0xE17;
  export const subCommand = 0;

  /** Wire name override — this cmd lives outside the standard
   *  `OidbSvcTrpcTcp.0xNNNN_N` namespace. */
  export const wireName = (): string => 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0';

  export interface Params { }

  export type Deps = OidbSender & Pick<BridgeContext, 'identity'>;

  export const serialize = (ctx: Deps, _p: Params): Oidb0xe17Req => {
    const reqObj = {
      uint64_uin: String(ctx.identity.uin),
      uint64_top: 0,
      uint32_req_num: 99,
      bytes_cookies: '',
    };
    return { jsonBody: JSON.stringify(reqObj) };
  };

  export const deserialize = (_ctx: Deps, body: Oidb0xe17Resp): UnidirectionalFriendEntry[] => {
    if (!body || !body.jsonBody) throw new Error('get unidirectional friend list empty');
    const parsed = JSON.parse(body.jsonBody) as { rpt_block_list?: UnidirectionalFriendEntry[] };
    return parsed.rpt_block_list || [];
  };

  export const encode = (env: OidbBase<Oidb0xe17Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0xe17Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0xe17Resp> =>
    protobuf_decode<OidbBase<Oidb0xe17Resp>>(bytes);

  export const invoke = (deps: Deps): Promise<UnidirectionalFriendEntry[]> =>
    invokeOidb(deps, GetUnidirectionalFriendList, {});
}
