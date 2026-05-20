// Handles GroupMemberIncreaseNotice (33) + GroupMemberDecreaseNotice (34) +
// GroupSelfJoinedNotice (85, bot-self admittance).
//
// 33/34 share GroupChangeSchema; the decreaseType field distinguishes
// kick vs voluntary leave (dt != 0 && dt != 130 means kicked).
//
// 85 carries a different wire shape (`SelfJoinInGroup`) — without it
// the bot has no signal that its own `set_group_add_request` was
// approved (33 fires only for *other* members joining). We surface
// 85 as a regular GroupMemberJoin with `userUin = selfUin` so the
// existing OneBot converter naturally produces
// `notice.group_increase` with `sub_type: 'approve' | 'invite'`
// (the converter compares operator == user to pick the sub_type;
// for self-join the operator is the admin/inviter, so 'invite' is
// emitted — matching go-cqhttp / NapCat semantics).

import { protobuf_decode } from '@snowluma/proton';
import type { GroupChange, SelfJoinInGroup } from '../../proto/proton/notify';
import type { GroupMemberJoin, GroupMemberLeave } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeOperatorUid, resolveUidToUin } from '../helpers';

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
