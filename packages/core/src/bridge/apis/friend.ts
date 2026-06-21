import { ApproveDoubtBuddyReq } from '@snowluma/protocol/oidb-services/friend/approve-doubt-buddy-req';
import { DeleteFriend } from '@snowluma/protocol/oidb-services/friend/delete-friend';
import { GetDoubtBuddyReq, type DoubtBuddyRequest } from '@snowluma/protocol/oidb-services/friend/get-doubt-buddy-req';
import { HandleFriendRequest } from '@snowluma/protocol/oidb-services/friend/handle-friend-request';
import { RejectDoubtBuddyReq } from '@snowluma/protocol/oidb-services/friend/reject-doubt-buddy-req';
import { SetFriendRemark } from '@snowluma/protocol/oidb-services/friend/set-friend-remark';
import type { BridgeContext } from '../bridge-context';

export type { DoubtBuddyRequest };

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
    await DeleteFriend.invoke(this.ctx, { userId, block });

    // Refresh friend cache after deletion so subsequent reads don't
    // surface a ghost entry. Best-effort: a transient OIDB hiccup here
    // shouldn't make the delete itself look failed.
    try { await this.ctx.apis.contacts.fetchFriendList(); } catch { /* ignore */ }
  }

  setRemark(userId: number, remark: string): Promise<void> {
    return SetFriendRemark.invoke(this.ctx, { userId, remark });
  }

  /** List doubtful friend-add requests (可能认识的人). */
  getDoubtRequests(count: number): Promise<DoubtBuddyRequest[]> {
    return GetDoubtBuddyReq.invoke(this.ctx, { count });
  }

  /** Approve a doubtful friend-add request by its uid (the list item's flag). */
  approveDoubtRequest(uid: string): Promise<void> {
    return ApproveDoubtBuddyReq.invoke(this.ctx, { uid });
  }

  /** Reject (delete/decline) a doubtful friend-add request by its uid. */
  rejectDoubtRequest(uid: string): Promise<void> {
    return RejectDoubtBuddyReq.invoke(this.ctx, { uid });
  }
}
