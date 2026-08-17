// 0xef0_1 — getGroupExt0xEF0Info. Used to read the current robot-add
// switch/examine values that set_group_robot_add_option writes.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGetGroupExtReq, OidbGetGroupExtResp } from '@snowluma/proto-defs/oidb-actions/group-ext';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface GroupExtRobotOption {
  robotMemberSwitch: number;
  robotMemberExamine: number;
}

export namespace FetchGroupExtInfo {
  export const command = 0xEF0;
  export const subCommand = 1;
  export const uinForm = true;

  export interface Params { groupId: number; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGetGroupExtReq => ({
    groupCodes: [BigInt(p.groupId)],
    filter: {
      inviteRobotMemberSwitch: 1,
      inviteRobotMemberExamine: 1,
    },
  });

  export const deserialize = (_ctx: Deps, body: OidbGetGroupExtResp): GroupExtRobotOption => {
    const item = body.items?.[0];
    if (!item) {
      throw new Error('unable to read group robot-add option');
    }
    if (item.resultCode && item.resultCode !== 0) {
      throw new Error(`unable to read group robot-add option: result=${item.resultCode}`);
    }
    return {
      robotMemberSwitch: item.ext?.inviteRobotMemberSwitch ?? 0,
      robotMemberExamine: item.ext?.inviteRobotMemberExamine ?? 0,
    };
  };

  export const encode = (env: OidbBase<OidbGetGroupExtReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGetGroupExtReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGetGroupExtResp> =>
    protobuf_decode<OidbBase<OidbGetGroupExtResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<GroupExtRobotOption> =>
    invokeOidb(deps, FetchGroupExtInfo, params);
}
