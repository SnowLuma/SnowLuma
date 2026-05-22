// FriendApi — facade over friend-roster OIDB cmds. Every method is a
// one-line forwarder to a self-contained namespace under
// @snowluma/bridge/oidb-services/friend. The `delete()` facade method
// adds a best-effort friend-list cache invalidation after the OIDB
// call succeeds — that side-effect stays on the facade because it
// reaches into `ctx.apis.contacts`, which the namespace deliberately
// can't see.

import type { BridgeContext } from '../bridge-context';
import { HandleFriendRequest } from '@snowluma/bridge/oidb-services/friend/handle-friend-request';
import { DeleteFriend } from '@snowluma/bridge/oidb-services/friend/delete-friend';
import { SetFriendRemark } from '@snowluma/bridge/oidb-services/friend/set-friend-remark';

export class FriendApi {
  constructor(private readonly ctx: BridgeContext) {}

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
