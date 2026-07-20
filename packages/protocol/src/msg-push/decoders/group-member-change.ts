import { protobuf_decode } from '@snowluma/proton';
import type { GroupMemberJoin, GroupMemberLeave } from '../../events';
import type { GroupChange, SelfJoinInGroup } from '@snowluma/proto-defs/notify';
import {
  decodeGroupChangeOperatorUid,
  decodeNestedOperatorUid,
  resolveUidToUin,
} from '../helpers';
import type { MsgPushDecoder } from '../registry';

function joinTypeFromOperationType(raw: number): NonNullable<GroupMemberJoin['joinType']> {
  // QQ uses bit 0x80 as a flag on the PkgType=33 operation code. Clear only
  // that bit: other high bits remain significant in the native handler. The
  // normalized code 3 means an invitation; all other values mean approval.
  // Do not use the nested `join_type`: that is an invitation-source enum.
  const normalized = raw - (raw & 0x80);
  return normalized === 3 ? 'invite' : 'approve';
}

export const decodeGroupMemberJoin: MsgPushDecoder = (ctx) => {
  const change = protobuf_decode<GroupChange>(ctx.content);
  if (!change) return [];
  const groupId = change.groupUin ?? 0;
  const userUid = change.memberUid ?? '';
  const operatorUid = decodeGroupChangeOperatorUid(
    change.operatorBytes ?? new Uint8Array(0),
    'group member increase',
  );
  const ev: GroupMemberJoin = {
    kind: 'group_member_join',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    userUin: resolveUidToUin(ctx.identity, groupId, userUid, 0),
    operatorUin: resolveUidToUin(ctx.identity, groupId, operatorUid, 0),
    userUid,
    operatorUid,
    joinType: joinTypeFromOperationType(change.decreaseType ?? 0),
  };
  return [ev];
};

// QQ's GroupChange.decreaseType (proto field 4) on a member-decrease push:
//   3   → the bot itself was kicked
//   129 → the group was disbanded
//   130 → voluntary leave
//   131 → another member was kicked
//   0 / absent → treat as voluntary leave (defensive default)
// The kick → kick_me distinction (was it us?) is decided downstream in the
// OneBot converter via selfId; here we only resolve the protocol-level reason.
function leaveTypeFromDecreaseType(dt: number): GroupMemberLeave['leaveType'] {
  switch (dt) {
    case 129:
      return 'disband';
    case 0:
    case 130:
      return 'leave';
    default:
      return 'kick';
  }
}

export const decodeGroupMemberLeave: MsgPushDecoder = (ctx) => {
  const change = protobuf_decode<GroupChange>(ctx.content);
  if (!change) return [];
  const dt = change.decreaseType ?? 0;
  const groupId = change.groupUin ?? 0;
  const userUid = change.memberUid ?? '';
  const userUin = resolveUidToUin(ctx.identity, groupId, userUid, 0);

  let operatorUid: string;
  let operatorUin: number;
  if (dt === 130) {
    // A voluntary leave has no independent operator. QQ may place structured
    // metadata in field 5, so it must not be decoded as a UID. OneBot models
    // the leaving member as the operator for this event.
    operatorUid = userUid;
    operatorUin = userUin;
  } else {
    const operatorBytes = change.operatorBytes ?? new Uint8Array(0);
    // Self-kick always uses OperatorInfo. Ordinary removals vary between a raw
    // UTF-8 UID and the same envelope, so discriminate by its field-1 wire tag.
    operatorUid = dt === 3
      ? decodeNestedOperatorUid(operatorBytes, 'group member decrease type=3')
      : decodeGroupChangeOperatorUid(operatorBytes, `group member decrease type=${dt}`);
    operatorUin = resolveUidToUin(ctx.identity, groupId, operatorUid, 0);
  }
  const ev: GroupMemberLeave = {
    kind: 'group_member_leave',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    userUin,
    operatorUin,
    userUid,
    operatorUid,
    leaveType: leaveTypeFromDecreaseType(dt),
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
