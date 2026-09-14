// 0xFD4_1 — single-page friend-roster fetch.
//
// QQ paginates the friend list with an opaque wire-level cookie.
// This namespace handles ONE round-trip — the facade drives the
// while-loop until the server stops emitting a cookie and
// concatenates results into the public FriendInfo[] shape.

import type { OidbBase, OidbFriend, OidbSvcTrpcTcp0xFD4_1Response } from '@snowluma/proto-defs/oidb';
import type { OidbFriendListRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { FriendInfo } from '../../qq-info';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface FriendListPageEntry {
  friend: FriendInfo;
  categoryId: number;
}

export interface FriendListPageCategory {
  categoryId: number;
  categoryName: string;
  memberCount: number;
  sortId: number;
}

export interface FriendListPage {
  entries: FriendListPageEntry[];
  categories: FriendListPageCategory[];
  cookie?: Uint8Array;
}

function friendProperties(raw: OidbFriend): Map<number, string> {
  const props = new Map<number, string>();
  for (const additional of raw.additional ?? []) {
    if ((additional.type ?? 0) !== 1 || !additional.layer1) continue;
    for (const property of additional.layer1.properties ?? []) {
      props.set(property.code ?? 0, property.value ?? '');
    }
  }
  return props;
}

function mapFriend(raw: OidbFriend): FriendListPageEntry {
  const props = friendProperties(raw);
  return {
    categoryId: raw.customGroup ?? 0,
    friend: {
      uin: raw.uin ?? 0,
      uid: raw.uid ?? '',
      nickname: props.get(20002) ?? String(raw.uin ?? 0),
      remark: props.get(103) ?? '',
    },
  };
}

export namespace FetchFriendListPage {
  export const command = 0xFD4;
  export const subCommand = 1;

  export interface Params {
    /** Opaque cookie returned by the previous page. Omit on page one. */
    cookie?: Uint8Array;
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
    if (p.cookie?.length) {
      body.cookie = p.cookie;
    }
    return body;
  };

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0xFD4_1Response): FriendListPage => ({
    entries: (body.friends ?? []).map(mapFriend),
    categories: (body.categories ?? []).map((raw) => ({
      categoryId: raw.categoryId ?? 0,
      categoryName: raw.categoryName ?? '',
      memberCount: raw.memberCount ?? 0,
      sortId: raw.sortId ?? 0,
    })),
    cookie: body.cookie?.length ? Uint8Array.from(body.cookie) : undefined,
  });

  export const encode = (env: OidbBase<OidbFriendListRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbFriendListRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0xFD4_1Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<FriendListPage> =>
    invokeOidb(deps, FetchFriendListPage, params);
}
