// Handles GroupRequestJoinNotice (84) + GroupRequestInvitationNotice (525)
// + GroupInviteNotice (87). All three produce GroupInviteEvent with
// different subType ('add' / 'invite') and flag prefixes.

import { protoDecode } from '../../../protobuf/decode';
import {
  GroupJoinSchema, GroupInvitationSchema, GroupInviteSchema,
} from '../../proto/notify';
import type { GroupInviteEvent } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { resolveUidToUin } from '../helpers';

export const decodeGroupJoinRequest: MsgPushDecoder = (ctx) => {
  const join = protoDecode(ctx.content, GroupJoinSchema);
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
  const invitation = protoDecode(ctx.content, GroupInvitationSchema);
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
  const invite = protoDecode(ctx.content, GroupInviteSchema);
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
