// 0x9082 — set / unset emoji reaction on a group message.
//   subCommand 1 = set, 2 = unset
//
// Cross-checked against LagrangeV2
// `Internal/Packets/Service/SetGroupReaction.cs`:
//   field 2 groupUin (long)
//   field 3 sequence (ulong)
//   field 4 code     (string)  ← emoji id
//   field 5 type     (ulong)   ← 1 for QQ-face short id, 2 for unicode codepoint
// (Heuristic on `code.length > 3` matches Lagrange's
// `GroupAddReactionEvent.IsEmoji` discriminator.)

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbGroupReaction } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetReaction {
  export const command = 0x9082;

  export interface Params {
    groupId: number;
    sequence: number;
    /** Emoji code. 1–3 digits → QQ face (type=1); longer → unicode (type=2). */
    code: string;
    /** true = set reaction (subCommand 1), false = unset (subCommand 2). */
    isSet: boolean;
  }

  /** Only the wire-send capability is needed. */
  export type Deps = OidbSender;

  export const resolveSubCommand = (p: Params): number => p.isSet ? 1 : 2;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupReaction => ({
    groupUin: p.groupId,
    sequence: p.sequence,
    code: p.code,
    type: p.code.length > 3 ? 2 : 1,
    field6: false,
    field7: false,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbGroupReaction>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupReaction>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetReaction, params);
}
