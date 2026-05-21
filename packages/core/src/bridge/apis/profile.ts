// ProfileApi — personal profile + status + avatar + likes + custom
// faces + unidirectional friend list. Inlined from
// `actions/profile.ts` (deleted alongside actions/* in commit 13).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  FaceroamOpReq,
  FaceroamOpResp,
  GroupAvatarExtra,
  Oidb0x112aReq,
  Oidb0x112aResp,
  Oidb0x7edReq,
  Oidb0x7edResp,
  Oidb0xcd4Req,
  Oidb0xcd4Resp,
  Oidb0xe17Req,
  Oidb0xe17Resp,
  OidbSetProfile,
  SetStatusReq,
  SetStatusResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';
import { fetchHighwaySession, uploadHighwayHttp } from '@snowluma/bridge/highway';
import { computeHashes, loadBinarySource } from '@snowluma/bridge/highway/utils';
import { resolveSelfUid } from './shared';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

export class ProfileApi {
  constructor(private readonly ctx: BridgeContext) {}

  // ─────────────── status / profile setters ───────────────

  async setOnlineStatus(status: number, extStatus = 0, batteryStatus = 100): Promise<void> {
    await this.dispatchSetStatus({ status, extStatus, batteryStatus });
  }

  /**
   * DIY (custom) online status. napcat fixes status=10 / extStatus=2000
   * — the values QQ associates with "I have a custom status string" —
   * and threads the faceId / wording / faceType through the customExt
   * sub-message of the same SetStatus wire call.
   */
  async setDiyOnlineStatus(faceId: number, wording: string, faceType: number): Promise<void> {
    await this.dispatchSetStatus({
      status: 10,
      extStatus: 2000,
      batteryStatus: 0,
      customExt: { faceId, text: wording, faceType },
    });
  }

  private async dispatchSetStatus(value: {
    status: number;
    extStatus: number;
    batteryStatus: number;
    customExt?: { faceId: number; text: string; faceType: number };
  }): Promise<void> {
    const request = protobuf_encode<SetStatusReq>(value);
    const result = await this.ctx.sendRawPacket(
      'trpc.qq_new_tech.status_svc.StatusService.SetStatus',
      request,
    );

    if (!result.success) {
      throw new Error(result.errorMessage || 'set online status failed (network/timeout)');
    }

    if (result.responseData && result.responseData.length > 0) {
      const resp = protobuf_decode<SetStatusResp>(result.responseData);
      if (!resp) {
        throw new Error(result.errorMessage || 'set online status failed (network/timeout)');
      }
      if (resp.errCode !== undefined && resp.errCode !== 0) {
        throw new Error(resp.errMsg || `set online status failed with errCode: ${resp.errCode}`);
      }
    }
  }

  async setProfile(nickname?: string, personalNote?: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const uin = BigInt(this.ctx.identity.uin);
    const stringProfiles: any[] = [];
    const intProfiles: any[] = [];

    if (nickname !== undefined) {
      stringProfiles.push({ fieldId: 20002, value: nickname });
    }

    if (personalNote !== undefined) {
      stringProfiles.push({ fieldId: 102, value: personalNote });
    }

    if (stringProfiles.length === 0 && intProfiles.length === 0) {
      return;
    }

    const req = { uin, stringProfiles };
    const env = makeOidbEnvelope<OidbSetProfile>(0x112A, 2, req);
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x112a_2', protobuf_encode<OidbBase<OidbSetProfile>>(env));
  }

  async setSelfLongNick(longNick: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const req = {
      uin: BigInt(this.ctx.identity.uin),
      profile: {
        tag: 102,
        value: String(longNick),
      },
    };

    const env = makeOidbEnvelope<Oidb0x112aReq>(0x112A, 2, req);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x112a_2', protobuf_encode<OidbBase<Oidb0x112aReq>>(env));
    // Decode just to maintain the original behaviour of "consume the response".
    protobuf_decode<OidbBase<Oidb0x112aResp>>(respBytes);
  }

  async setInputStatus(userId: number, eventType: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const targetUid = await this.ctx.resolveUserUid(userId);

    if (!targetUid) {
      throw new Error('target uid not found');
    }

    const req = {
      reqBody: {
        uid: targetUid,
        chatType: 0,
        eventType,
      },
    };

    const env = makeOidbEnvelope<Oidb0xcd4Req>(0xCD4, 1, req);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xcd4_1', protobuf_encode<OidbBase<Oidb0xcd4Req>>(env));
    protobuf_decode<OidbBase<Oidb0xcd4Resp>>(respBytes);
  }

  async setAvatar(source: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const loaded = await loadBinarySource(source, 'avatar');
    if (!loaded.bytes.length) throw new Error('avatar file is empty');

    const hashes = computeHashes(loaded.bytes);
    const session = await fetchHighwaySession(bridge);
    await uploadHighwayHttp(bridge, session, 90, loaded.bytes, hashes.md5, new Uint8Array(0));
  }

  /**
   * Set group avatar. Mirrors Lagrange.Core's GroupSetAvatar:
   *   - same highway HTTP upload as personal avatar
   *   - cmdId 3000 (instead of 90)
   *   - GroupAvatarExtra proto carried as the `extend` blob, with the
   *     four protocol-prescribed constants (type=101, field5=3, field6=1,
   *     field3.field1=1) and the target groupUin.
   *
   * Source ref: Lagrange.Core/Internal/Context/Logic/Implementation/OperationLogic.cs#GroupSetAvatar.
   */
  async setGroupAvatar(groupId: number, source: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const loaded = await loadBinarySource(source, 'group-avatar');
    if (!loaded.bytes.length) throw new Error('group avatar file is empty');

    const hashes = computeHashes(loaded.bytes);
    const session = await fetchHighwaySession(bridge);
    const extra = protobuf_encode<GroupAvatarExtra>({
      type: 101,
      groupUin: groupId,
      field3: { field1: 1 },
      field5: 3,
      field6: 1,
    });
    await uploadHighwayHttp(bridge, session, 3000, loaded.bytes, hashes.md5, extra);
  }

  // ─────────────── queries on me / my contacts ───────────────

  async getLike(userId?: number, start = 0, limit = 10): Promise<any> {
    const bridge = asBridge(this.ctx);
    const isSelf = !userId;
    const targetUid = isSelf
      ? await resolveSelfUid(bridge)
      : await this.ctx.resolveUserUid(userId);

    if (!targetUid) {
      throw new Error('target uid not found');
    }

    const req = {
      targetUid,
      basic: 1,
      vote: 1,
      favorite: 1,
      start,
      limit,
    };

    const env = makeOidbEnvelope<Oidb0x7edReq>(0x7ED, 12, req);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x7ed_12', protobuf_encode<OidbBase<Oidb0x7edReq>>(env));
    const result = protobuf_decode<OidbBase<Oidb0x7edResp>>(respBytes).body;

    const data = result?.userLikeInfos?.[0];
    if (!data) {
      throw new Error('get profile like info empty');
    }

    return {
      uid: data.uid,
      time: Number(data.time),
      favoriteInfo: {
        total_count: data.favoriteInfo?.totalCount || 0,
        last_time: Number(data.favoriteInfo?.lastTime || 0),
        today_count: data.favoriteInfo?.newCount || 0,
        userInfos: [],
      },
      voteInfo: {
        total_count: data.voteInfo?.totalCount || 0,
        new_count: data.voteInfo?.newCount || 0,
        new_nearby_count: 0,
        last_visit_time: Number(data.voteInfo?.lastTime || 0),
        userInfos: [],
      },
    };
  }

  async getUnidirectionalFriendList(): Promise<any> {
    const bridge = asBridge(this.ctx);
    const reqObj = {
      uint64_uin: String(this.ctx.identity.uin),
      uint64_top: 0,
      uint32_req_num: 99,
      bytes_cookies: '',
    };

    const req = { jsonBody: JSON.stringify(reqObj) };
    const env = makeOidbEnvelope<Oidb0xe17Req>(0xE17, 0, req);
    const respBytes = await runOidb(bridge, 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0', protobuf_encode<OidbBase<Oidb0xe17Req>>(env));
    const result = protobuf_decode<OidbBase<Oidb0xe17Resp>>(respBytes).body;

    if (!result || !result.jsonBody) {
      throw new Error('get unidirectional friend list empty');
    }

    const parsed = JSON.parse(result.jsonBody);
    return parsed.rpt_block_list || [];
  }

  async fetchCustomFace(count = 10): Promise<string[]> {
    const req = {
      inner: { field1: 1, osVersion: '10.0.26200', qqVersion: '9.9.28-46928' },
      uin: BigInt(this.ctx.identity.uin),
      field3: 1,
      field6: 1,
    };
    const request = protobuf_encode<FaceroamOpReq>(req);
    const result = await this.ctx.sendRawPacket('Faceroam.OpReq', request);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(result.errorMessage || 'fetch custom face failed');
    }
    const resp = protobuf_decode<FaceroamOpResp>(result.responseData);
    if (!resp || (resp as any).retCode !== 0) {
      throw new Error(`fetch custom face error: ${(resp as any)?.message || 'unknown'}`);
    }
    const faceIds = (resp as any).item?.faceIds || [];
    return faceIds.slice(0, count).map((id: string) => `https://p.qpic.cn/qq_expression/${this.ctx.identity.uin}/${id}/0`);
  }
}
