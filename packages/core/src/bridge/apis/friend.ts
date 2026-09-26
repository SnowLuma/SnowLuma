import { createLogger } from '@snowluma/common/logger';
import { findDatalineDeviceByUin } from '@snowluma/protocol/dataline/device-contacts';
import { ApproveDoubtBuddyReq } from '@snowluma/protocol/oidb-services/friend/approve-doubt-buddy-req';
import { ClearFriendRemark } from '@snowluma/protocol/oidb-services/friend/clear-friend-remark';
import { DeleteFriend } from '@snowluma/protocol/oidb-services/friend/delete-friend';
import { GetDoubtBuddyReq, type DoubtBuddyRequest } from '@snowluma/protocol/oidb-services/friend/get-doubt-buddy-req';
import { HandleFriendRequest } from '@snowluma/protocol/oidb-services/friend/handle-friend-request';
import { RejectDoubtBuddyReq } from '@snowluma/protocol/oidb-services/friend/reject-doubt-buddy-req';
import { SetFriendRemark } from '@snowluma/protocol/oidb-services/friend/set-friend-remark';
import type { BridgeContext } from '../bridge-context';

export type { DoubtBuddyRequest };

const log = createLogger('Bridge.Friend');

export class FriendApi {
  constructor(private readonly ctx: BridgeContext) { }

  /**
   * Accept or reject an inbound friend request. `uidOrFlag` is either a
   * pre-resolved UID string or a numeric uin (then resolved on the fly).
   */
  handleRequest(uidOrFlag: string, approve: boolean): Promise<void> {
    return HandleFriendRequest.invoke(this.ctx, { uidOrFlag, approve });
  }

  async delete(userId: number, block = false): Promise<void> {
    if (findDatalineDeviceByUin(userId)) {
      throw new Error('this contact cannot be deleted');
    }
    await DeleteFriend.invoke(this.ctx, { userId, block });

    // The server-side delete has already completed. A refresh failure must be
    // visible, but throwing here would misreport the delete itself as failed
    // and encourage callers to repeat a destructive request.
    try {
      await this.ctx.apis.contacts.fetchFriendList();
    } catch (err: unknown) {
      log.warn(
        'friend-list refresh failed after deleting user=%d: %s',
        userId,
        err instanceof Error ? err.message : String(err),
      );
    }
  }

  async setRemark(userId: number, remark: string): Promise<void> {
    if (findDatalineDeviceByUin(userId)) {
      throw new Error('this contact does not support remarks');
    }
    if (remark === '') {
      await ClearFriendRemark.invoke(this.ctx, { userId });
      return;
    }
    await SetFriendRemark.invoke(this.ctx, { userId, remark });
  }

  /** List doubtful friend-add requests (可能认识的人). */
  async getDoubtRequests(count: number): Promise<DoubtBuddyRequest[]> {
    const list = await GetDoubtBuddyReq.invoke(this.ctx, { count });
    return Promise.all(list.map(async (item) => {
      let uid = item.uid;
      let userId = item.user_id;
      if (userId <= 0 && uid) {
        userId = this.ctx.identity.findUinByUid(uid) ?? 0;
      }
      // Applicants need not be friends or share a group. Use Identity's
      // profile lookup when the list only supplies an account number.
      if (!uid && userId > 0) {
        try {
          uid = await this.ctx.resolveUserUid(userId);
        } catch (err: unknown) {
          log.warn(
            'doubt-request uid resolve failed: user=%d err=%s',
            userId,
            err instanceof Error ? err.message : String(err),
          );
        }
      }
      return { ...item, uid: uid || '', user_id: userId };
    }));
  }

  /** Approve a doubtful friend-add request. `uidOrFlag` is the list uid, or a digit-only account number. */
  async approveDoubtRequest(uidOrFlag: string): Promise<void> {
    log.trace('doubt-request approval: resolving applicant');
    const uid = await this.resolveDoubtFlag(uidOrFlag);
    log.trace('doubt-request approval: submitting request');
    await ApproveDoubtBuddyReq.invoke(this.ctx, { uid });
    log.trace('doubt-request approval: completed');
  }

  /** Reject (delete/decline) a doubtful friend-add request. `uidOrFlag` matches `approveDoubtRequest`. */
  async rejectDoubtRequest(uidOrFlag: string): Promise<void> {
    return RejectDoubtBuddyReq.invoke(this.ctx, {
      uid: await this.resolveDoubtFlag(uidOrFlag),
    });
  }

  /**
   * Digit-only flags are account numbers and must be translated before the
   * approval/reject packet is built. A raw number in that packet is rejected
   * by the server. Same rule as inbound friend-request handling.
   */
  private resolveDoubtFlag(uidOrFlag: string): Promise<string> {
    if (!/^\d+$/.test(uidOrFlag)) return Promise.resolve(uidOrFlag);
    return this.ctx.resolveUserUid(parseInt(uidOrFlag, 10));
  }
}
