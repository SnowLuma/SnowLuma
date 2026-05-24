// 0x8A7_0 — query "@everyone" remaining-use budget for the bot in
// the given group. Server returns two independent counters: a
// per-uin budget (the bot's daily allowance) and a per-group budget
// (the group's shared allowance). The OneBot action surfaces both
// alongside a single `can_at_all` boolean.
//
// The req's `basic{1,2,3}` triplet (1/2/1) is the wire-known
// validation cookie NTQQ emits; the server rejects requests with
// different values. `type = 0` means "query" (no other type seen).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x8a7Req, Oidb0x8a7Resp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export interface AtAllRemain {
  can_at_all: boolean;
  remain_at_all_count_for_group: number;
  remain_at_all_count_for_uin: number;
}

export namespace GetAtAllRemain {
  export const command = 0x8A7;
  export const subCommand = 0;

  export interface Params { groupId: number; }

  export type Deps = OidbSender & Pick<BridgeContext, 'identity'>;

  export const serialize = (ctx: Deps, p: Params): Oidb0x8a7Req => ({
    basic1: 1,
    basic2: 2,
    basic3: 1,
    uin: BigInt(ctx.identity.uin),
    groupId: BigInt(p.groupId),
    type: 0,
  });

  export const deserialize = (_ctx: Deps, body: Oidb0x8a7Resp): AtAllRemain => {
    // Cast numbers to plain Number: the OIDB layer may surface uint32
    // as BigInt and the WebUI JSON serializer chokes on those.
    return {
      can_at_all: !!body.canAtAll,
      remain_at_all_count_for_group: Number(body.groupRemain ?? 0),
      remain_at_all_count_for_uin: Number(body.uinRemain ?? 0),
    };
  };

  export const encode = (env: OidbBase<Oidb0x8a7Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x8a7Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x8a7Resp> =>
    protobuf_decode<OidbBase<Oidb0x8a7Resp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<AtAllRemain> =>
    invokeOidb(deps, GetAtAllRemain, params);
}
