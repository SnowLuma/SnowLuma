// FriendApi — friend roster mutations (handle add request /
// delete / set remark). Inlined from `actions/friend.ts` (deleted
// alongside actions/* in commit 13). The READ side of friends
// (fetchFriendList) lives on ContactsApi because friends/groups
// share the same roster pipeline.

import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbDeleteFriend,
  OidbFriendRequestAction,
  OidbSetFriendRemark,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

export class FriendApi {
  constructor(private readonly ctx: BridgeContext) {}

  /**
   * Accept or reject an inbound friend request. `uidOrFlag` is either a
   * pre-resolved UID string or a numeric uin (then resolved on the fly).
   */
  async handleRequest(uidOrFlag: string, approve: boolean): Promise<void> {
    const bridge = asBridge(this.ctx);
    let targetUid = uidOrFlag;
    if (/^\d+$/.test(uidOrFlag)) {
      targetUid = await this.ctx.resolveUserUid(parseInt(uidOrFlag, 10));
    }
    const env = makeOidbEnvelope<OidbFriendRequestAction>(0xB5D, 44, { accept: approve ? 3 : 5, targetUid });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0xb5d_44', protobuf_encode<OidbBase<OidbFriendRequestAction>>(env));
  }

  async delete(userId: number, block = false): Promise<void> {
    const bridge = asBridge(this.ctx);
    const targetUid = await this.ctx.resolveUserUid(userId);
    const env = makeOidbEnvelope<OidbDeleteFriend>(0x126B, 0, {
      field1: {
        targetUid,
        field2: {
          field1: 130,
          field2: 109,
          field3: {
            field1: 8,
            field2: 8,
            field3: 50,
          },
        },
        block,
        field4: false,
      },
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x126b_0', protobuf_encode<OidbBase<OidbDeleteFriend>>(env));

    // Refresh friend cache after deletion so subsequent reads don't
    // surface a ghost entry. Best-effort: a transient OIDB hiccup here
    // shouldn't make the delete itself look failed.
    try { await this.ctx.apis.contacts.fetchFriendList(); } catch { /* ignore */ }
  }

  async setRemark(userId: number, remark: string): Promise<void> {
    const bridge = asBridge(this.ctx);
    const uid = await this.ctx.resolveUserUid(userId);
    const env = makeOidbEnvelope<OidbSetFriendRemark>(0xB6E, 2, { targetUid: uid, remark });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0xb6e_2', protobuf_encode<OidbBase<OidbSetFriendRemark>>(env));
  }
}
