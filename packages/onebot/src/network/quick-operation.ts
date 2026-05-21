import type { ApiHandler } from '../api-handler';
import type { JsonObject, JsonValue } from '../types';

export async function executeQuickOperation(
  event: JsonObject,
  operation: Record<string, unknown>,
  api: ApiHandler,
): Promise<void> {
  const postType = event.post_type as string;

  if (postType === 'message') {
    if (operation.reply !== undefined && operation.reply !== null && operation.reply !== '') {
      const messageType = event.message_type as string;
      const autoEscape = !!operation.auto_escape;

      if (messageType === 'group') {
        const params: JsonObject = {
          group_id: event.group_id as number,
          message: operation.reply as JsonValue,
          auto_escape: autoEscape,
        };
        if (operation.at_sender !== false && event.user_id) {
          const atSegment = { type: 'at', data: { qq: String(event.user_id) } };
          if (typeof operation.reply === 'string') {
            params.message = [atSegment, { type: 'text', data: { text: operation.reply as string } }] as JsonValue;
            params.auto_escape = false;
          } else if (Array.isArray(operation.reply)) {
            params.message = [atSegment, ...(operation.reply as unknown[])] as JsonValue;
          }
        }
        await api.handle('send_group_msg', params);
      } else if (messageType === 'private') {
        await api.handle('send_private_msg', {
          user_id: event.user_id as number,
          message: operation.reply as JsonValue,
          auto_escape: autoEscape,
        });
      }
    }

    if (operation.delete) {
      await api.handle('delete_msg', { message_id: event.message_id as number });
    }

    if (operation.ban && event.message_type === 'group') {
      const duration = typeof operation.ban_duration === 'number' ? operation.ban_duration : 1800;
      await api.handle('set_group_ban', {
        group_id: event.group_id as number,
        user_id: event.user_id as number,
        duration: duration as JsonValue,
      });
    }

    if (operation.kick && event.message_type === 'group') {
      await api.handle('set_group_kick', {
        group_id: event.group_id as number,
        user_id: event.user_id as number,
        reject_add_request: !!operation.reject_add_request,
      });
    }
  }

  if (postType === 'request') {
    if (operation.approve !== undefined) {
      const requestType = event.request_type as string;
      if (requestType === 'friend') {
        await api.handle('set_friend_add_request', {
          flag: event.flag as string,
          approve: operation.approve as JsonValue,
          remark: (operation.remark ?? '') as JsonValue,
        });
      } else if (requestType === 'group') {
        await api.handle('set_group_add_request', {
          flag: event.flag as string,
          sub_type: event.sub_type as string,
          approve: operation.approve as JsonValue,
          reason: (operation.reason ?? '') as JsonValue,
        });
      }
    }
  }
}
