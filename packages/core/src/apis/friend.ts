import { DeleteFriend } from '@snowluma/protocol/oidb-services/friend/delete-friend';
import { HandleFriendRequest } from '@snowluma/protocol/oidb-services/friend/handle-friend-request';
import { SetFriendRemark } from '@snowluma/protocol/oidb-services/friend/set-friend-remark';
import type { CoreContext } from '../core-context';

export class FriendApi {
  constructor(private readonly ctx: CoreContext) { }

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
}
