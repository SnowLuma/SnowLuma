import type { GroupInvitation, GroupInvite } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

import { IdentityService } from '../../src/identity-service';
import type { MsgPushContext } from '../../src/msg-push/context';
import {
  decodeGroupInvitation,
  decodeGroupInvite,
} from '../../src/msg-push/decoders/group-join-request';

const SELF_UIN = 10001;
const GROUP_ID = 12345;

function ctx(content: Uint8Array, identity = IdentityService.memory(String(SELF_UIN))): MsgPushContext {
  return {
    head: {
      msgType: 33, subType: 0, c2cCmd: 0, sequence: 1, ntMsgSeq: 0,
      timestamp: 1_710_000_000, msgId: 1,
    },
    fromUin: GROUP_ID,
    fromUid: '',
    selfUin: SELF_UIN,
    content,
    body: undefined,
    responseHead: undefined,
    identity,
    isHistorical: false,
  };
}

describe('group invitation push carries the invitee (#394)', () => {
  it('keeps the inviter as from* and the invitee as invited*', () => {
    const identity = IdentityService.memory(String(SELF_UIN));
    identity.rememberRequestIdentity({ uid: 'u_inviter', uin: 456, source: 'group_request' });
    identity.rememberRequestIdentity({ uid: 'u_invitee', uin: 789, source: 'group_request' });
    const content = protobuf_encode<GroupInvitation>({
      cmd: 87,
      info: {
        inner: {
          groupUin: GROUP_ID,
          targetUid: 'u_invitee',
          invitorUid: 'u_inviter',
        },
      },
    });

    const [event] = decodeGroupInvitation(ctx(content, identity));
    expect(event).toMatchObject({
      kind: 'group_invite',
      groupId: GROUP_ID,
      fromUin: 456,
      fromUid: 'u_inviter',
      invitedUin: 789,
      invitedUid: 'u_invitee',
      subType: 'invite',
    });
  });

  it('treats a self-invite as inviting the logged-in account', () => {
    const content = protobuf_encode<GroupInvite>({
      groupUin: GROUP_ID,
      invitorUid: 'u_inviter',
    });

    const [event] = decodeGroupInvite(ctx(content));
    expect(event).toMatchObject({
      kind: 'group_invite',
      fromUid: 'u_inviter',
      invitedUin: SELF_UIN,
      subType: 'invite',
    });
  });
});
