// GroupAdminApi — mute/kick/admin/card/name/title/leave + join-policy
// + add-request handling. Inlined from the previous
// `actions/group-admin.ts` (deleted alongside the rest of the
// actions/* facade in commit 13).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x89a_0AddOption,
  Oidb0x89a_0Search,
  Oidb0x8a0Req,
  Oidb0x8a7Req,
  Oidb0x8a7Resp,
  Oidb0xf16Req,
  OidbGroupRequestAction,
  OidbKickMember,
  OidbLeaveGroup,
  OidbMuteAll,
  OidbMuteMember,
  OidbRenameGroup,
  OidbRenameMember,
  OidbSetAdmin,
  OidbSpecialTitle,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

export class GroupAdminApi {
  constructor(private readonly ctx: BridgeContext) {}

  async muteMember(groupId: number, userId: number, duration: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const uid = await this.ctx.resolveUserUid(userId, groupId);
    const env = makeOidbEnvelope<OidbMuteMember>(0x1253, 1, {
      groupUin: groupId, type: 1, body: { targetUid: uid, duration },
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x1253_1', protobuf_encode<OidbBase<OidbMuteMember>>(env));
  }

  async muteAll(groupId: number, enable: boolean): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbMuteAll>(0x89A, 0, {
      groupUin: groupId, muteState: { state: enable ? 0xFFFFFFFF : 0 },
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_0', protobuf_encode<OidbBase<OidbMuteAll>>(env));
  }

  async setAddOption(groupId: number, addType: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<Oidb0x89a_0AddOption>(0x89A, 0, {
      groupUin: BigInt(groupId), settings: { addType }, field12: 0,
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_0', protobuf_encode<OidbBase<Oidb0x89a_0AddOption>>(env));
  }

  async setSearch(groupId: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<Oidb0x89a_0Search>(0x89A, 0, {
      groupUin: BigInt(groupId), settings: new Uint8Array(0), field12: 0,
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_0', protobuf_encode<OidbBase<Oidb0x89a_0Search>>(env));
  }

  async setAddRequest(
    groupId: number, sequence: number, eventType: number,
    approve: boolean, reason = '', filtered = false,
  ): Promise<void> {
    const bridge = asBridge(this.ctx);
    const subCmd = filtered ? 2 : 1;
    const cmd = filtered ? 'OidbSvcTrpcTcp.0x10c8_2' : 'OidbSvcTrpcTcp.0x10c8_1';
    const env = makeOidbEnvelope<OidbGroupRequestAction>(
      0x10C8, subCmd,
      { accept: approve ? 1 : 2, body: { sequence: BigInt(sequence), eventType, groupUin: groupId, message: reason } },
      true,
    );
    await runOidb(bridge, cmd, protobuf_encode<OidbBase<OidbGroupRequestAction>>(env));
  }

  async kickMember(groupId: number, userId: number, reject: boolean, reason = ''): Promise<void> {
    const bridge = asBridge(this.ctx);
    const uid = await this.ctx.resolveUserUid(userId, groupId);
    const env = makeOidbEnvelope<OidbKickMember>(0x8A0, 1, {
      groupUin: groupId, targetUid: uid, rejectAddRequest: reject, reason,
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x8a0_1', protobuf_encode<OidbBase<OidbKickMember>>(env));
  }

  async kickMembers(groupId: number, userIds: number[], reject: boolean): Promise<void> {
    const bridge = asBridge(this.ctx);
    const targetUids = await Promise.all(userIds.map(userId => this.ctx.resolveUserUid(userId, groupId)));
    const env = makeOidbEnvelope<Oidb0x8a0Req>(0x8A0, 1, {
      groupId: BigInt(groupId), targetUids, rejectAddRequest: reject ? 1 : 0, kickReason: new Uint8Array(0), field12: 0,
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x8a0_1', protobuf_encode<OidbBase<Oidb0x8a0Req>>(env));
  }

  async leave(groupId: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbLeaveGroup>(0x1097, 1, { groupUin: groupId });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x1097_1', protobuf_encode<OidbBase<OidbLeaveGroup>>(env));
  }

  async setAdmin(groupId: number, userId: number, enable: boolean): Promise<void> {
    const bridge = asBridge(this.ctx);
    const uid = await this.ctx.resolveUserUid(userId, groupId);
    const env = makeOidbEnvelope<OidbSetAdmin>(0x1096, 1, { groupUin: groupId, uid, isAdmin: enable });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x1096_1', protobuf_encode<OidbBase<OidbSetAdmin>>(env));
  }

  async setCard(groupId: number, userId: number, card: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const uid = await this.ctx.resolveUserUid(userId, groupId);
    const env = makeOidbEnvelope<OidbRenameMember>(0x8FC, 3, {
      groupUin: groupId, body: { targetUid: uid, targetName: card },
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x8fc_3', protobuf_encode<OidbBase<OidbRenameMember>>(env));
  }

  async setName(groupId: number, name: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbRenameGroup>(0x89A, 15, { groupUin: groupId, body: { targetName: name } });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x89a_15', protobuf_encode<OidbBase<OidbRenameGroup>>(env));
  }

  async setSpecialTitle(groupId: number, userId: number, title: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const uid = await this.ctx.resolveUserUid(userId, groupId);
    const env = makeOidbEnvelope<OidbSpecialTitle>(0x8FC, 2, {
      groupUin: groupId, body: { targetUid: uid, specialTitle: title, expireTime: -1 },
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x8fc_2', protobuf_encode<OidbBase<OidbSpecialTitle>>(env));
  }

  /**
   * The bot's local-only label for a group. Lives here rather than
   * `FriendApi` because the semantic is "operate on a group" rather
   * than "operate on a contact list".
   */
  async setRemark(groupId: number, remark: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<Oidb0xf16Req>(0xF16, 1, { inner: { groupId: BigInt(groupId), remark }, field12: 0 });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0xf16_1', protobuf_encode<OidbBase<Oidb0xf16Req>>(env));
  }

  async getAtAllRemain(groupId: number): Promise<{
    can_at_all: boolean;
    remain_at_all_count_for_group: number;
    remain_at_all_count_for_uin: number;
  }> {
    const bridge = asBridge(this.ctx);
    const req = {
      basic1: 1,
      basic2: 2,
      basic3: 1,
      uin: BigInt(this.ctx.identity.uin),
      groupId: BigInt(groupId),
      type: 0,
    };
    const env = makeOidbEnvelope<Oidb0x8a7Req>(0x8A7, 0, req);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x8a7_0', protobuf_encode<OidbBase<Oidb0x8a7Req>>(env));
    const result = protobuf_decode<OidbBase<Oidb0x8a7Resp>>(respBytes).body;
    if (!result) throw new Error('get group at all remain result empty');

    // Cast numbers to plain Number: the OIDB layer may surface uint32
    // as BigInt and the WebUI JSON serializer chokes on those.
    return {
      can_at_all: !!result.canAtAll,
      remain_at_all_count_for_group: Number(result.groupRemain || 0),
      remain_at_all_count_for_uin: Number(result.uinRemain || 0),
    };
  }
}
