import { protobuf_decode } from '@snowluma/proton';
import type { GroupInviteEvent } from '../../events';
import type {
  GroupInvitation, GroupInvite,
  GroupJoin,
} from '@snowluma/proto-defs/notify';
import { resolveUidToUin } from '../helpers';
import type { MsgPushDecoder } from '../registry';

export const decodeGroupJoinRequest: MsgPushDecoder = (ctx) => {
  const join = protobuf_decode<GroupJoin>(ctx.content);
  if (!join) return [];
  const ev: GroupInviteEvent = {
    kind: 'group_invite',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: join.groupUin ?? 0,
    fromUin: resolveUidToUin(ctx.identity, join.groupUin ?? 0, join.targetUid ?? '', ctx.fromUin),
    fromUid: join.targetUid ?? '',
    subType: 'add',
    message: '',
    flag: 'add:' + (join.groupUin ?? 0) + ':' + (join.targetUid ?? ''),
  };
  return [ev];
};

export const decodeGroupInvitation: MsgPushDecoder = (ctx) => {
  const invitation = protobuf_decode<GroupInvitation>(ctx.content);
  if (!invitation?.info?.inner) return [];
  const inner = invitation.info.inner;
  const ev: GroupInviteEvent = {
    kind: 'group_invite',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: inner.groupUin ?? 0,
    fromUin: resolveUidToUin(ctx.identity, inner.groupUin ?? 0, inner.invitorUid ?? '', ctx.fromUin),
    fromUid: inner.invitorUid ?? '',
    subType: 'invite',
    message: '',
    flag: 'invite:' + (inner.groupUin ?? 0) + ':' + (inner.invitorUid ?? ''),
  };
  return [ev];
};

export const decodeGroupInvite: MsgPushDecoder = (ctx) => {
  const invite = protobuf_decode<GroupInvite>(ctx.content);
  if (!invite) return [];
  const ev: GroupInviteEvent = {
    kind: 'group_invite',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: invite.groupUin ?? 0,
    fromUin: resolveUidToUin(ctx.identity, invite.groupUin ?? 0, invite.invitorUid ?? '', ctx.fromUin),
    fromUid: invite.invitorUid ?? '',
    subType: 'invite',
    message: '',
    flag: 'invite:' + (invite.groupUin ?? 0) + ':' + (invite.invitorUid ?? ''),
  };
  return [ev];
};
