// Friend-list operations: accept/reject add request, delete, set the
// local remark label. Each one resolves a UID first because the OIDB
// protocol uses opaque UIDs rather than QQ uin numbers.

import { protobuf_encode } from '@snowluma/proton';
import type { Bridge } from '../bridge';
import { runOidb, makeOidbEnvelope } from '../bridge-oidb';
import type {
  OidbDeleteFriend,
  OidbFriendRequestAction,
  OidbSetFriendRemark,
} from '../proto/proton/oidb-actions/base';
import { OidbBase } from '../proto/proton/oidb';

export async function setFriendAddRequest(bridge: Bridge, uidOrFlag: string, approve: boolean): Promise<void> {
  let targetUid = uidOrFlag;
  if (/^\d+$/.test(uidOrFlag)) {
    targetUid = await bridge.resolveUserUid(parseInt(uidOrFlag, 10));
  }
  const env = makeOidbEnvelope<OidbFriendRequestAction>(0xB5D, 44, { accept: approve ? 3 : 5, targetUid });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0xb5d_44', protobuf_encode<OidbBase<OidbFriendRequestAction>>(env));
}

export async function deleteFriend(bridge: Bridge, userId: number, block = false): Promise<void> {
  const targetUid = await bridge.resolveUserUid(userId);
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
  try { await bridge.fetchFriendList(); } catch { /* ignore */ }
}

export async function setFriendRemark(bridge: Bridge, userId: number, remark: string): Promise<void> {
  const uid = await bridge.resolveUserUid(userId);
  const env = makeOidbEnvelope<OidbSetFriendRemark>(0xB6E, 2, { targetUid: uid, remark });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0xb6e_2', protobuf_encode<OidbBase<OidbSetFriendRemark>>(env));
}
