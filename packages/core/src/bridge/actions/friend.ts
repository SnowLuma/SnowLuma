// Friend-list operations: accept/reject add request, delete, set the
// local remark label. Each one resolves a UID first because the OIDB
// protocol uses opaque UIDs rather than QQ uin numbers.

import type { Bridge } from '../bridge';
import { runOidb } from '../bridge-oidb';
import {
  OidbDeleteFriendSchema,
  OidbFriendRequestActionSchema,
  OidbSetFriendRemarkSchema,
} from '../proto/oidb-action';

export async function setFriendAddRequest(bridge: Bridge, uidOrFlag: string, approve: boolean): Promise<void> {
  let targetUid = uidOrFlag;
  if (/^\d+$/.test(uidOrFlag)) {
    targetUid = await bridge.resolveUserUid(parseInt(uidOrFlag, 10));
  }
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xb5d_44',
    oidbCmd: 0xB5D, subCmd: 44,
    request: { schema: OidbFriendRequestActionSchema, value: { accept: approve ? 3 : 5, targetUid } },
  });
}

export async function deleteFriend(bridge: Bridge, userId: number, block = false): Promise<void> {
  const targetUid = await bridge.resolveUserUid(userId);
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x126b_0',
    oidbCmd: 0x126B, subCmd: 0,
    request: {
      schema: OidbDeleteFriendSchema,
      value: {
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
      },
    },
  });

  // Refresh friend cache after deletion so subsequent reads don't
  // surface a ghost entry. Best-effort: a transient OIDB hiccup here
  // shouldn't make the delete itself look failed.
  try { await bridge.fetchFriendList(); } catch { /* ignore */ }
}

export async function setFriendRemark(bridge: Bridge, userId: number, remark: string): Promise<void> {
  const uid = await bridge.resolveUserUid(userId);
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xb6e_2',
    oidbCmd: 0xB6E, subCmd: 2,
    request: { schema: OidbSetFriendRemarkSchema, value: { targetUid: uid, remark } },
  });
}
