// 0xFE5_2 — fetch the bot's joined-groups list with full per-group
// info.
//
// The verbose `config` blob in the request body asks QQ which
// per-group fields to include. Asking for everything blows the
// named-pipe write buffer on accounts with ~200+ groups (see #42),
// so we keep `config1.*` mostly on but turn off the costly
// `field5002`/`field5003` and entire `config2` block that never map
// back to a decoded field anyway.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0xFE5_2Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace FetchGroupList {
  export const command = 0xFE5;
  export const subCommand = 2;
  export const uinForm = true;

  export interface Params {}

  export type Deps = OidbSender;

  const allTrue = true;

  export const serialize = (_ctx: Deps, _: Params): OidbGroupListRequest => ({
    config: {
      config1: {
        groupOwner: allTrue, field2: allTrue, memberMax: allTrue, memberCount: allTrue,
        groupName: allTrue, field8: allTrue, field9: allTrue, field10: allTrue,
        field11: allTrue, field12: allTrue, field13: allTrue, field14: allTrue,
        field15: allTrue, field16: allTrue, field17: allTrue, field18: allTrue,
        question: allTrue, field20: allTrue, field22: allTrue, field23: allTrue,
        field24: allTrue, field25: allTrue, field26: allTrue, field27: allTrue,
        field28: allTrue, field29: allTrue, field30: allTrue, field31: allTrue,
        field32: allTrue, field5001: allTrue, field5002: false, field5003: false,
      },
      config2: {
        field1: false, field2: false, field3: false, field4: false,
        field5: false, field6: false, field7: false, field8: false,
      },
      config3: { field5: allTrue, field6: allTrue },
    },
  });

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0xFE5_2Response): OidbSvcTrpcTcp0xFE5_2Response => body;

  export const encode = (env: OidbBase<OidbGroupListRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupListRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0xFE5_2Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFE5_2Response>>(bytes);

  export const invoke = (deps: Deps): Promise<OidbSvcTrpcTcp0xFE5_2Response> =>
    invokeOidb(deps, FetchGroupList, {});
}
