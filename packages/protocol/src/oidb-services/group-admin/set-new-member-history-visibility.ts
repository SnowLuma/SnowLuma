// 0x89A_0 — control whether newly joined members may browse group history.
// QQ sends the complete current groupFlagExt4 value with a mutation mask, so
// callers must read the flag before invoking this namespace.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0HistoryVisibility } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export const GROUP_HISTORY_VISIBILITY_MASK = 0x4;

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
    throw new Error(`${name} must be an unsigned 32-bit integer`);
  }
}

export function mergeGroupHistoryVisibility(currentGroupFlagExt4: number, visible: boolean): number {
  assertUint32(currentGroupFlagExt4, 'current group history flag');
  const current = BigInt(currentGroupFlagExt4);
  const mask = BigInt(GROUP_HISTORY_VISIBILITY_MASK);
  return Number(visible ? current | mask : current & ~mask);
}

export namespace SetNewMemberHistoryVisibility {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    currentGroupFlagExt4: number;
    visible: boolean;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x89a_0HistoryVisibility => ({
    groupUin: BigInt(p.groupId),
    settings: {
      groupFlagExt4: mergeGroupHistoryVisibility(p.currentGroupFlagExt4, p.visible),
      groupFlagExt4Mask: GROUP_HISTORY_VISIBILITY_MASK,
    },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x89a_0HistoryVisibility>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x89a_0HistoryVisibility>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetNewMemberHistoryVisibility, params);
}
