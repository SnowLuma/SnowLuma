import type { QQEventVariant } from '@snowluma/protocol/events';
import type { JsonObject } from '../types';
import type { ConverterContext } from './index';
import { request } from './envelope';

type FriendRequest = Extract<QQEventVariant, { kind: 'friend_request' }>;
type GroupInvite = Extract<QQEventVariant, { kind: 'group_invite' }>;

export function convertFriendRequest(ctx: ConverterContext, event: FriendRequest): JsonObject {
  return request(ctx, event, {
    request_type: 'friend',
    user_id: event.fromUin,
    comment: event.message,
    flag: event.flag,
  });
}

export function convertGroupInvite(ctx: ConverterContext, event: GroupInvite): JsonObject {
  const invitedId = event.invitedUin ?? 0;
  return request(ctx, event, {
    request_type: 'group',
    sub_type: event.subType || 'invite',
    group_id: event.groupId,
    user_id: event.fromUin,
    ...(invitedId > 0 ? { invited_id: invitedId } : {}),
    comment: event.message,
    flag: event.flag,
  });
}
