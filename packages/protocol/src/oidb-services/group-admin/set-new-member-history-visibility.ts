// 0x89A_0 — control whether newly joined members may browse group history.
// Mutation writes the extended-flag value plus a one-bit mask. The matching
// group-detail reply is a 0/1 switch (omitted means hidden), not the full
// extended-flag bitfield.

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

export function decodeGroupHistoryVisibility(groupFlagExt4: number): boolean {
  assertUint32(groupFlagExt4, 'group history flag');
  // Detail replies use 0/1. The mutation bitfield still uses bit 2.
  return groupFlagExt4 === 1 || (groupFlagExt4 & GROUP_HISTORY_VISIBILITY_MASK) !== 0;
}

export namespace SetNewMemberHistoryVisibility {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    visible: boolean;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x89a_0HistoryVisibility => ({
    groupUin: BigInt(p.groupId),
    settings: {
      groupFlagExt4: p.visible ? GROUP_HISTORY_VISIBILITY_MASK : 0,
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
