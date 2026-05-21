import type { SnowLumaApiClient } from '../client/api-client';
import type { SnowLumaEvent } from '../types/index';
import { isGroupMessageEvent, isPrivateMessageEvent, isRequestEvent } from './guards';
import type { SnowLumaEventContext } from './types';


export function createEventContext<TEvent extends SnowLumaEvent>(
  event: TEvent,
  client: SnowLumaApiClient,
): SnowLumaEventContext<TEvent> {
  let stopped = false;

  const context: SnowLumaEventContext<TEvent> = {
    event,
    client,
    get stopped() {
      return stopped;
    },
    stopPropagation() {
      stopped = true;
    },
    async reply(message, options) {
      if (isGroupMessageEvent(event)) {
        return client.sendGroupMessage(event.group_id, message, options);
      }
      if (isPrivateMessageEvent(event)) {
        return client.sendPrivateMessage(event.user_id, message, options);
      }
      throw new Error('reply() is only available for message events');
    },
    async approve(options) {
      if (!isRequestEvent(event)) {
        throw new Error('approve() is only available for request events');
      }
      if (event.request_type === 'friend') {
        return client.setFriendAddRequest(event.flag, true, options);
      }
      if (event.request_type === 'group') {
        return client.setGroupAddRequest(event.flag, {
          ...options,
          subType: options?.subType ?? event.sub_type,
          approve: true,
        });
      }
      throw new Error(`approve() does not support request_type=${event.request_type}`);
    },
    async reject(reason, options) {
      if (!isRequestEvent(event)) {
        throw new Error('reject() is only available for request events');
      }
      if (event.request_type === 'friend') {
        return client.setFriendAddRequest(event.flag, false, options);
      }
      if (event.request_type === 'group') {
        return client.setGroupAddRequest(event.flag, {
          ...options,
          subType: options?.subType ?? event.sub_type,
          approve: false,
          reason: reason ?? options?.reason,
        });
      }
      throw new Error(`reject() does not support request_type=${event.request_type}`);
    },
    async quickOperation(operation, options) {
      return client.raw('.handle_quick_operation', {
        context: event,
        operation,
      }, options);
    },
  };

  return context;
}
