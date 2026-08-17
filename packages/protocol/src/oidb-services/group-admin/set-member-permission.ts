// 0x89A_0 — update one member capability through the appPrivilegeFlag deny
// bits. Current QQ applies one selected mask per operation; callers that change
// multiple capabilities must invoke this namespace sequentially.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0MemberPermission } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export type GroupMemberPermission = 'upload_album' | 'temporary_session' | 'create_group';

export const GROUP_MEMBER_PERMISSION_MASKS: Record<GroupMemberPermission, number> = {
  upload_album: 0x1,
  temporary_session: 0x10000,
  create_group: 0x8000,
};

function assertUint32(value: number, name: string): void {
  if (!Number.isInteger(value) || value < 0 || value > 0xFFFFFFFF) {
    throw new Error(`${name} must be an unsigned 32-bit integer`);
  }
}

export function mergeGroupMemberPermission(
  currentPrivilegeFlag: number,
  permission: GroupMemberPermission,
  allow: boolean,
): number {
  assertUint32(currentPrivilegeFlag, 'current privilege flag');
  const current = BigInt(currentPrivilegeFlag);
  const mask = BigInt(GROUP_MEMBER_PERMISSION_MASKS[permission]);
  return Number(allow ? current & ~mask : current | mask);
}

export function decodeGroupMemberPermissions(privilegeFlag: number): {
  allowMemberUploadAlbum: boolean;
  allowMemberTemporarySession: boolean;
  allowMemberCreateGroup: boolean;
} {
  assertUint32(privilegeFlag, 'privilege flag');
  return {
    allowMemberUploadAlbum:
      (privilegeFlag & GROUP_MEMBER_PERMISSION_MASKS.upload_album) === 0,
    allowMemberTemporarySession:
      (privilegeFlag & GROUP_MEMBER_PERMISSION_MASKS.temporary_session) === 0,
    allowMemberCreateGroup:
      (privilegeFlag & GROUP_MEMBER_PERMISSION_MASKS.create_group) === 0,
  };
}

export namespace SetMemberPermission {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    currentPrivilegeFlag: number;
    permission: GroupMemberPermission;
    allow: boolean;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x89a_0MemberPermission => ({
    groupUin: BigInt(p.groupId),
    settings: {
      appPrivilegeFlag: mergeGroupMemberPermission(
        p.currentPrivilegeFlag,
        p.permission,
        p.allow,
      ),
      appPrivilegeMask: GROUP_MEMBER_PERMISSION_MASKS[p.permission],
    },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x89a_0MemberPermission>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x89a_0MemberPermission>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetMemberPermission, params);
}
