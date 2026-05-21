import type { QQEventVariant } from '@snowluma/bridge/events';
import type { JsonObject } from '../types';
import type { ConverterContext } from './index';

type FriendRequest = Extract<QQEventVariant, { kind: 'friend_request' }>;
type GroupInvite = Extract<QQEventVariant, { kind: 'group_invite' }>;

export function convertFriendRequest(ctx: ConverterContext, event: FriendRequest): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'request',
    request_type: 'friend',
    user_id: event.fromUin,
    comment: event.message,
    flag: event.flag,
  };
}

export function convertGroupInvite(ctx: ConverterContext, event: GroupInvite): JsonObject {
  return {
    time: event.time,
    self_id: ctx.selfId,
    post_type: 'request',
    request_type: 'group',
    sub_type: event.subType || 'invite',
    group_id: event.groupId,
    user_id: event.fromUin,
    comment: event.message,
    flag: event.flag,
  };
}
