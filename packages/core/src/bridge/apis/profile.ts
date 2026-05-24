import type {
  FaceroamOpReq,
  FaceroamOpResp,
  GroupAvatarExtra,
  SetStatusReq,
  SetStatusResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { fetchHighwaySession, uploadHighwayHttp } from '@snowluma/protocol/highway';
import { computeHashes, loadBinarySource } from '@snowluma/protocol/highway/utils';
import { GetLike } from '@snowluma/protocol/oidb-services/profile/get-like';
import { GetUnidirectionalFriendList } from '@snowluma/protocol/oidb-services/profile/get-unidirectional-friend-list';
import { SetInputStatus } from '@snowluma/protocol/oidb-services/profile/set-input-status';
import { SetProfile } from '@snowluma/protocol/oidb-services/profile/set-profile';
import { SetSelfLongNick } from '@snowluma/protocol/oidb-services/profile/set-self-long-nick';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { Bridge } from '../bridge';
import type { BridgeContext } from '../bridge-context';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

export class ProfileApi {
  constructor(private readonly ctx: BridgeContext) { }

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

  setProfile(nickname?: string, personalNote?: string): Promise<void> {
    return SetProfile.invoke(this.ctx, { nickname, personalNote });
  }

  setSelfLongNick(longNick: string): Promise<void> {
    return SetSelfLongNick.invoke(this.ctx, { longNick });
  }

  setInputStatus(userId: number, eventType: number): Promise<void> {
    return SetInputStatus.invoke(this.ctx, { userId, eventType });
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

  getLike(userId?: number, start = 0, limit = 10): Promise<any> {
    return GetLike.invoke(this.ctx, { userId, start, limit });
  }

  getUnidirectionalFriendList(): Promise<any> {
    return GetUnidirectionalFriendList.invoke(this.ctx);
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
