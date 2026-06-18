// 0xf00_3 — modifyGroupExtInfoV2, used for set_group_robot_add_option.
// RE'd from QQNT group_ext_list_modify_codec.cc:
//   ModifyGroupExtInfoReq{ 1:groupCode, 2:GroupExtInfo{ 1:groupCode,
//     2:EXTInfo{ 30:inviteRobotMemberSwitch, 31:inviteRobotMemberExamine } } }
// The NT GroupExtFilter (2nd kernel arg) is client-side only — it just gates
// which EXTInfo fields the encoder emits — so we mirror that by only setting
// the fields the caller provides. uin-form OIDB (envelope reserved=1).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbModifyGroupExtReq, OidbModifyGroupExtResp, OidbGroupExtBody,
} from '@snowluma/proto-defs/oidb-actions/group-ext';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace ModifyGroupExtInfo {
  export const command = 0xF00;
  export const subCommand = 3;
  export const uinForm = true;

  export interface Params {
    groupId: number;
    /** undefined → leave unchanged (field not emitted). */
    robotMemberSwitch?: number;
    robotMemberExamine?: number;
  }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbModifyGroupExtReq => {
    const ext: OidbGroupExtBody = {};
    if (p.robotMemberSwitch !== undefined) ext.inviteRobotMemberSwitch = p.robotMemberSwitch;
    if (p.robotMemberExamine !== undefined) ext.inviteRobotMemberExamine = p.robotMemberExamine;
    return {
      groupCode: p.groupId,
      info: { groupCode: p.groupId, ext },
    };
  };

  export const deserialize = (_ctx: Deps, body: OidbModifyGroupExtResp): void => {
    // Envelope-level OIDB errors are already thrown by invokeOidb; this is the
    // body-level ack. 0 (or absent) = success.
    if (body.result && body.result !== 0) {
      throw new Error(`modifyGroupExtInfo failed: result=${body.result}`);
    }
  };

  export const encode = (env: OidbBase<OidbModifyGroupExtReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbModifyGroupExtReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbModifyGroupExtResp> =>
    protobuf_decode<OidbBase<OidbModifyGroupExtResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, ModifyGroupExtInfo, params);
}
