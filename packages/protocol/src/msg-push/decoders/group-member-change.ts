import { protobuf_decode } from '@snowluma/proton';
import type { GroupMemberJoin, GroupMemberLeave } from '../../events';
import type { GroupChange, SelfJoinInGroup } from '@snowluma/proto-defs/notify';
import { decodeOperatorUid, resolveUidToUin } from '../helpers';
import type { MsgPushDecoder } from '../registry';

export const decodeGroupMemberJoin: MsgPushDecoder = (ctx) => {
  const change = protobuf_decode<GroupChange>(ctx.content);
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
  const change = protobuf_decode<GroupChange>(ctx.content);
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

export const decodeGroupSelfJoined: MsgPushDecoder = (ctx) => {
  const joined = protobuf_decode<SelfJoinInGroup>(ctx.content);
  if (!joined) return [];
  // groupUin is uint_64 on the wire (bigint). Real group IDs fit in
  // uint32 (≤ 10 digits in practice), so Number() conversion is safe
  // — saturate to 0 on the unlikely overflow rather than letting
  // BigInt propagate downstream where consumers expect a number.
  const groupUinBig = joined.groupUin ?? 0n;
  const groupId = groupUinBig > 0n && groupUinBig <= 0x7FFFFFFFn ? Number(groupUinBig) : 0;
  const operatorUid = joined.operatorUid ?? '';
  // We're the one joining — surface the bot's own identity as userUin
  // so the existing converter's `notice.group_increase` shape works
  // unchanged.
  const ev: GroupMemberJoin = {
    kind: 'group_member_join',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    userUin: ctx.selfUin,
    userUid: ctx.identity.selfUid ?? '',
    operatorUin: resolveUidToUin(ctx.identity, groupId, operatorUid, 0),
    operatorUid,
  };
  return [ev];
};
