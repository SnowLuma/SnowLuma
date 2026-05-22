// 0xEAC — set / unset a group "essence" message (群精华).
//   subCommand 1 = mark as essence, 2 = remove from essence
//
// `random` is the message's wire-level random field (carried through
// from the original send so the server can resolve the canonical
// message identity).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbEssence } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetEssence {
  export const command = 0xEAC;

  export interface Params {
    groupId: number;
    sequence: number;
    random: number;
    /** true = mark essence (subCmd 1), false = unmark (subCmd 2). */
    enable: boolean;
  }

  export type Deps = OidbSender;

  export const resolveSubCommand = (p: Params): number => p.enable ? 1 : 2;

  export const serialize = (p: Params): OidbEssence => ({
    groupUin: p.groupId,
    sequence: p.sequence,
    random: p.random,
  });

  export const deserialize = (_: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbEssence>): Uint8Array =>
    protobuf_encode<OidbBase<OidbEssence>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetEssence, params);
}
