import type {
  FaceroamOpReq,
  FaceroamOpResp,
  GroupAvatarExtra,
  SetStatusReq,
  SetStatusResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { AddCustomFace } from '@snowluma/protocol/oidb-services/custom-face/add-custom-face';
import { DeleteCustomFace } from '@snowluma/protocol/oidb-services/custom-face/delete-custom-face';
import { ModifyCustomFace } from '@snowluma/protocol/oidb-services/custom-face/modify-custom-face';
import { MoveCustomFace } from '@snowluma/protocol/oidb-services/custom-face/move-custom-face';
import { OrderCustomFace } from '@snowluma/protocol/oidb-services/custom-face/order-custom-face';
import { fetchHighwaySession, uploadHighwayHttp } from '@snowluma/protocol/highway';
import { computeHashes, loadBinarySource } from '@snowluma/protocol/highway/utils';
import { GetLike, type LikeInfo } from '@snowluma/protocol/oidb-services/profile/get-like';
import { GetUnidirectionalFriendList, type UnidirectionalFriendEntry } from '@snowluma/protocol/oidb-services/profile/get-unidirectional-friend-list';
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

  getLike(userId?: number, start = 0, limit = 10): Promise<LikeInfo> {
    return GetLike.invoke(this.ctx, { userId, start, limit });
  }

  getUnidirectionalFriendList(): Promise<UnidirectionalFriendEntry[]> {
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
    if (!resp || resp.retCode !== 0) {
      throw new Error(`fetch custom face error: ${resp?.message || 'unknown'}`);
    }
    const faceIds = resp.item?.faceIds || [];
    return faceIds.slice(0, count).map((id: string) => `https://p.qpic.cn/qq_expression/${this.ctx.identity.uin}/${id}/0`);
  }

  /** 删除一个收藏表情（custom face）。emoji_id 来自 fetchCustomFace 返回的 URL 路径段。 */
  deleteCustomFace(emojiId: string): Promise<void> {
    return DeleteCustomFace.invoke(this.ctx, { uin: this.ctx.identity.uin, emojiId });
  }

  /**
   * 添加收藏表情（custom face）。imageSource 支持 file:///、base64://、http(s)://
   * （复用 highway utils 的 loadBinarySource）。返回新 emoji_id。
   */
  async addCustomFace(imageSource: string): Promise<string> {
    const { bytes } = await loadBinarySource(imageSource, 'custom-face');
    return AddCustomFace.invoke(this.ctx, { uin: this.ctx.identity.uin, imageBytes: bytes });
  }

  /**
   * 修改收藏表情（custom face）备注。emoji_id 来自 fetchCustomFace 返回的
   * URL 路径段；md5 从 emoji_id 中段解析，无需调用方单独提供。desc 为空串
   * 则清空备注。
   */
  modifyCustomFace(emojiId: string, desc: string): Promise<void> {
    return ModifyCustomFace.invoke(this.ctx, {
      emojiId,
      md5: md5FromEmojiId(emojiId),
      desc,
    });
  }

  /**
   * 收藏表情（custom face）移到最前。QQ 客户端只有"移动到最前"，协议层
   * （0x902f 的 f3=1）也只支持最前，不支持移到其他位置。两步流程：先 0x902f
   * 移动指令，再 0x902e opType=2 上传新顺序（fetch 当前列表把目标挪到第一）。
   * 两步都发才生效。
   */
  async moveCustomFaceToFront(emojiId: string): Promise<void> {
    // 1. fetch 当前完整列表（fetch 顺序即可，不需要 DB 显示顺序）
    const urls = await this.fetchCustomFace(1000);
    const ids = urls.map((url) => {
      const m = /\/qq_expression\/[^/]+\/([^/]+)\//.exec(url);
      return m ? m[1] : '';
    }).filter(Boolean);
    const idx = ids.indexOf(emojiId);
    if (idx < 0) throw new Error(`emoji_id not in list: ${emojiId}`);
    // 新顺序：目标挪到第一，其余按原顺序
    const reordered = ids.slice();
    reordered.splice(idx, 1);
    reordered.unshift(emojiId);
    // 2. 0x902f 移动指令（f3=1 = 移到最前）
    await OrderCustomFace.invoke(this.ctx, { emojiId, position: 1 });
    // 3. 0x902e opType=2 上传新顺序
    await MoveCustomFace.invoke(this.ctx, {
      emojis: reordered.map((id) => ({ emojiId: id, md5: md5FromEmojiId(id) })),
    });
  }
}

/**
 * 从 emoji_id `<uin>_0_0_0_<MD5>_0_0` 提取中段 32 位大写 hex MD5。
 * 格式固定（fetch/delete/move 共用），取第 5 段。解析失败抛错——比静默
 * 传空串让服务端拒绝更早定位问题。
 */
function md5FromEmojiId(emojiId: string): string {
  const parts = emojiId.split('_');
  // 期望形如 `<uin>_0_0_0_<md5>_0_0`，共 7 段，md5 在 index 4。
  const md5 = parts[4];
  if (!md5 || md5.length !== 32 || !/^[0-9a-fA-F]{32}$/.test(md5)) {
    throw new Error(`invalid emoji_id (cannot extract md5): ${emojiId}`);
  }
  return md5.toUpperCase();
}
