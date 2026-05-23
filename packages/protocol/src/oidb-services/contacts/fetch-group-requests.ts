// 0x10C0 — fetch pending group-add requests.
//   subCommand 1 = main inbox, 2 = filtered (low-priority) inbox
//
// Returns the wire shape verbatim — the facade does the GroupRequestInfo
// mapping because it also needs to thread the `filtered` flag onto
// each entry, which the wire doesn't carry.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0x10C0Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestList } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace FetchGroupRequests {
  export const command = 0x10C0;

  export interface Params {
    /** false → subCmd 1 (main inbox), true → subCmd 2 (filtered). */
    filtered: boolean;
  }

  export type Deps = OidbSender;

  export const resolveSubCommand = (p: Params): number => p.filtered ? 2 : 1;

  export const serialize = (_ctx: Deps, _: Params): OidbGroupRequestList => ({
    count: 20,
    field2: 0,
  });

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0x10C0Response): OidbSvcTrpcTcp0x10C0Response => body;

  export const encode = (env: OidbBase<OidbGroupRequestList>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupRequestList>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0x10C0Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0x10C0Response>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbSvcTrpcTcp0x10C0Response> =>
    invokeOidb(deps, FetchGroupRequests, params);
}
