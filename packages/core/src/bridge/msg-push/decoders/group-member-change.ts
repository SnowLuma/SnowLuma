// Handles GroupMemberIncreaseNotice (33) + GroupMemberDecreaseNotice (34).
// Both share GroupChangeSchema; the decreaseType field distinguishes kick vs
// voluntary leave (dt != 0 && dt != 130 means kicked).

import { protoDecode } from '../../../protobuf/decode';
import { GroupChangeSchema } from '../../proto/notify';
import type { GroupMemberJoin, GroupMemberLeave } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeOperatorUid, resolveUidToUin } from '../helpers';

export const decodeGroupMemberJoin: MsgPushDecoder = (ctx) => {
  const change = protoDecode(ctx.content, GroupChangeSchema);
  if (!change) return [];
  const groupId = change.groupUin ?? 0;
  const userUid = change.memberUid ?? '';
  const operatorUid = decodeOperatorUid(change.operatorBytes ?? new Uint8Array(0));
  const ev: GroupMemberJoin = {
    kind: 'group_member_join',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    userUin: resolveUidToUin(ctx.identity, groupId, userUid, 0),
    operatorUin: resolveUidToUin(ctx.identity, groupId, operatorUid, 0),
    userUid,
    operatorUid,
  };
  return [ev];
};

export const decodeGroupMemberLeave: MsgPushDecoder = (ctx) => {
  const change = protoDecode(ctx.content, GroupChangeSchema);
  if (!change) return [];
  const dt = change.decreaseType ?? 0;
  const groupId = change.groupUin ?? 0;
  const userUid = change.memberUid ?? '';
  const operatorUid = decodeOperatorUid(change.operatorBytes ?? new Uint8Array(0));
  const ev: GroupMemberLeave = {
    kind: 'group_member_leave',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    userUin: resolveUidToUin(ctx.identity, groupId, userUid, 0),
    operatorUin: resolveUidToUin(ctx.identity, groupId, operatorUid, 0),
    userUid,
    operatorUid,
    isKick: dt !== 0 && dt !== 130,
  };
  return [ev];
};
