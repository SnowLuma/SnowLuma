// 0xFD4_1 — single-page friend-roster fetch.
//
// QQ paginates the friend list with a wire-level cursor (`nextUin`).
// This namespace handles ONE round-trip — the facade drives the
// while-loop until the server stops emitting a next cursor and
// concatenates results into the public FriendInfo[] shape.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbSvcTrpcTcp0xFD4_1Response } from '@snowluma/proto-defs/oidb';
import type { OidbFriendListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace FetchFriendListPage {
  export const command = 0xFD4;
  export const subCommand = 1;

  export interface Params {
    /** Cursor: `null` for the first page, otherwise the previous
     *  page's `nextUin`. */
    nextUin: number | null;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbFriendListRequest => {
    const body: OidbFriendListRequest = {
      friendCount: 300,
      field4: 0,
      field6: 1,
      field7: 0x7FFFFFFF,
      body: [
        { type: 1, number: { numbers: [103, 102, 20002, 27394] } },
        { type: 4, number: { numbers: [100, 101, 102] } },
      ],
      field10002: [13578, 13579, 13573, 13572, 13568],
      field10003: 4051,
    };
    if (p.nextUin !== null) {
      body.nextUin = { uin: p.nextUin };
    }
    return body;
  };

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0xFD4_1Response): OidbSvcTrpcTcp0xFD4_1Response => body;

  export const encode = (env: OidbBase<OidbFriendListRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbFriendListRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0xFD4_1Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbSvcTrpcTcp0xFD4_1Response> =>
    invokeOidb(deps, FetchFriendListPage, params);
}
