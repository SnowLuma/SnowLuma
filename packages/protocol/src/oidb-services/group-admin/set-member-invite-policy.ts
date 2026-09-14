// 0x89A_0 — change whether members may invite people and whether invitations
// require approval. QQ sends the complete current appPrivilegeFlag together
// with a mask, so callers must read the flag before invoking this namespace.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0InvitePolicy } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export type GroupMemberInvitePolicy =
  | 'disabled'
  | 'require_approval'
  | 'no_approval'
  | 'no_approval_under_100';

export const MEMBER_INVITE_PRIVILEGE_MASK = 0x06100000;

const POLICY_PRIVILEGE_BITS: Record<GroupMemberInvitePolicy, number> = {
  disabled: 0x04000000,
  require_approval: 0,
  no_approval: 0x00100000,
  no_approval_under_100: 0x02000000,
};

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
    throw new Error(`${name} must be an unsigned 32-bit integer`);
  }
}

export function mergeMemberInvitePrivilegeFlag(
  currentPrivilegeFlag: number,
  policy: GroupMemberInvitePolicy,
): number {
  assertUint32(currentPrivilegeFlag, 'current privilege flag');
  const current = BigInt(currentPrivilegeFlag);
  const mask = BigInt(MEMBER_INVITE_PRIVILEGE_MASK);
  const requested = BigInt(POLICY_PRIVILEGE_BITS[policy]);
  return Number((current & ~mask) | (requested & mask));
}

export function decodeMemberInvitePolicy(privilegeFlag: number): GroupMemberInvitePolicy {
  assertUint32(privilegeFlag, 'privilege flag');
  const bits = privilegeFlag & MEMBER_INVITE_PRIVILEGE_MASK;
  if ((bits & 0x04000000) !== 0) return 'disabled';
  if ((bits & 0x02000000) !== 0) return 'no_approval_under_100';
  if ((bits & 0x00100000) !== 0) return 'no_approval';
  return 'require_approval';
}

export namespace SetMemberInvitePolicy {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    currentPrivilegeFlag: number;
    policy: GroupMemberInvitePolicy;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x89a_0InvitePolicy => ({
    groupUin: BigInt(p.groupId),
    settings: {
      appPrivilegeFlag: mergeMemberInvitePrivilegeFlag(p.currentPrivilegeFlag, p.policy),
      appPrivilegeMask: MEMBER_INVITE_PRIVILEGE_MASK,
      allowMemberInvite: p.policy === 'disabled' ? 0 : 1,
    },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x89a_0InvitePolicy>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x89a_0InvitePolicy>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetMemberInvitePolicy, params);
}
