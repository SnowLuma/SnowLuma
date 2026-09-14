import { describe, expect, it, vi } from 'vitest';
import type { ApiHandler } from '../src/api-handler';
import { executeQuickOperation } from '../src/network/quick-operation';
import type { JsonObject } from '../src/types';

function mockApi(): { api: ApiHandler; handle: ReturnType<typeof vi.fn> } {
  const handle = vi.fn();
  return { api: { handle } as unknown as ApiHandler, handle };
}

const GROUP_MESSAGE: JsonObject = {
  post_type: 'message',
  message_type: 'group',
  group_id: 314159,
  user_id: 271828,
  message_id: 424242,
};

const PRIVATE_MESSAGE: JsonObject = {
  post_type: 'message',
  message_type: 'private',
  user_id: 13579,
  message_id: 24680,
};

describe('executeQuickOperation', () => {
  describe('message reply', () => {
    it('prepends an at segment to a group string reply and forces auto_escape off', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        reply: 'hello group',
        auto_escape: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: [
            { type: 'at', data: { qq: '271828' } },
            { type: 'text', data: { text: 'hello group' } },
          ],
          auto_escape: false,
        }],
      ]);
    });

    it('sends a raw group string reply when at_sender is false', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        reply: 'no at',
        at_sender: false,
        auto_escape: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: 'no at',
          auto_escape: true,
        }],
      ]);
    });

    it('defaults auto_escape to false for a group string reply without at', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        reply: 'plain',
        at_sender: false,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: 'plain',
          auto_escape: false,
        }],
      ]);
    });

    it('prepends an at segment to a group array reply without forcing auto_escape', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        reply: [
          { type: 'text', data: { text: 'hi' } },
          { type: 'face', data: { id: '14' } },
        ],
        auto_escape: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: [
            { type: 'at', data: { qq: '271828' } },
            { type: 'text', data: { text: 'hi' } },
            { type: 'face', data: { id: '14' } },
          ],
          auto_escape: true,
        }],
      ]);
    });

    it('leaves a non-string non-array group reply unwrapped when at_sender is on', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        reply: { type: 'image', data: { file: 'pic.jpg' } },
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: { type: 'image', data: { file: 'pic.jpg' } },
          auto_escape: false,
        }],
      ]);
    });

    it('does not at-wrap a group reply when the event has no user_id', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'message',
        message_type: 'group',
        group_id: 314159,
        message_id: 424242,
      }, {
        reply: 'nobody',
        auto_escape: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: 'nobody',
          auto_escape: true,
        }],
      ]);
    });

    it('does not at-wrap a group reply when user_id is 0', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'message',
        message_type: 'group',
        group_id: 314159,
        user_id: 0,
        message_id: 424242,
      }, { reply: 'zero-user' }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: 'zero-user',
          auto_escape: false,
        }],
      ]);
    });

    it('at-wraps a group string reply when at_sender is explicitly true', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        reply: 'explicit',
        at_sender: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: [
            { type: 'at', data: { qq: '271828' } },
            { type: 'text', data: { text: 'explicit' } },
          ],
          auto_escape: false,
        }],
      ]);
    });

    it('sends a private reply without at-wrapping', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(PRIVATE_MESSAGE, {
        reply: 'hello pm',
        auto_escape: true,
        at_sender: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_private_msg', {
          user_id: 13579,
          message: 'hello pm',
          auto_escape: true,
        }],
      ]);
    });

    it('coerces a truthy auto_escape on a private reply', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(PRIVATE_MESSAGE, {
        reply: [{ type: 'text', data: { text: 'seg' } }],
        auto_escape: 1,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_private_msg', {
          user_id: 13579,
          message: [{ type: 'text', data: { text: 'seg' } }],
          auto_escape: true,
        }],
      ]);
    });

    it('does not send a reply for an unknown message_type', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'message',
        message_type: 'guild',
        user_id: 9,
        message_id: 8,
      }, { reply: 'ignored' }, api);

      expect(handle).not.toHaveBeenCalled();
    });

    it.each([
      ['undefined', { reply: undefined }],
      ['null', { reply: null }],
      ['empty string', { reply: '' }],
    ] as const)('does not send a reply when reply is %s', async (_label, operation) => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, { ...operation }, api);

      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe('message delete', () => {
    it('deletes the event message_id', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, { delete: true }, api);

      expect(handle.mock.calls).toEqual([
        ['delete_msg', { message_id: 424242 }],
      ]);
    });

    it('does not delete when delete is falsy', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, { delete: 0 }, api);

      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe('message ban', () => {
    it('bans a group sender for an explicit duration', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        ban: true,
        ban_duration: 60,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_ban', {
          group_id: 314159,
          user_id: 271828,
          duration: 60,
        }],
      ]);
    });

    it('bans for 0 seconds when ban_duration is 0', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        ban: true,
        ban_duration: 0,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_ban', {
          group_id: 314159,
          user_id: 271828,
          duration: 0,
        }],
      ]);
    });

    it.each([
      ['omitted', {}],
      ['a string', { ban_duration: '90' }],
      ['null', { ban_duration: null }],
    ])('bans for 1800s when ban_duration is %s', async (_label, extra) => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, { ban: true, ...extra }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_ban', {
          group_id: 314159,
          user_id: 271828,
          duration: 1800,
        }],
      ]);
    });

    it('does not ban on a private message', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(PRIVATE_MESSAGE, {
        ban: true,
        ban_duration: 30,
      }, api);

      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe('message kick', () => {
    it('kicks a group sender and rejects later requests when asked', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        kick: true,
        reject_add_request: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_kick', {
          group_id: 314159,
          user_id: 271828,
          reject_add_request: true,
        }],
      ]);
    });

    it('kicks without reject_add_request when the flag is omitted', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, { kick: true }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_kick', {
          group_id: 314159,
          user_id: 271828,
          reject_add_request: false,
        }],
      ]);
    });

    it('coerces a truthy reject_add_request', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        kick: 1,
        reject_add_request: 'yes',
      }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_kick', {
          group_id: 314159,
          user_id: 271828,
          reject_add_request: true,
        }],
      ]);
    });

    it('does not kick on a private message', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(PRIVATE_MESSAGE, { kick: true }, api);

      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe('request approve', () => {
    it('approves a friend request with a remark', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'request',
        request_type: 'friend',
        flag: 'flag-friend-7',
      }, {
        approve: true,
        remark: 'buddy',
      }, api);

      expect(handle.mock.calls).toEqual([
        ['set_friend_add_request', {
          flag: 'flag-friend-7',
          approve: true,
          remark: 'buddy',
        }],
      ]);
    });

    it('rejects a friend request with an empty default remark', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'request',
        request_type: 'friend',
        flag: 'flag-friend-7',
      }, { approve: false }, api);

      expect(handle.mock.calls).toEqual([
        ['set_friend_add_request', {
          flag: 'flag-friend-7',
          approve: false,
          remark: '',
        }],
      ]);
    });

    it('approves a group request with a reason', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'request',
        request_type: 'group',
        sub_type: 'add',
        flag: 'flag-group-9',
      }, {
        approve: true,
        reason: 'ok',
      }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_add_request', {
          flag: 'flag-group-9',
          sub_type: 'add',
          approve: true,
          reason: 'ok',
        }],
      ]);
    });

    it('rejects a group request with an empty default reason', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'request',
        request_type: 'group',
        sub_type: 'invite',
        flag: 'flag-group-9',
      }, { approve: false }, api);

      expect(handle.mock.calls).toEqual([
        ['set_group_add_request', {
          flag: 'flag-group-9',
          sub_type: 'invite',
          approve: false,
          reason: '',
        }],
      ]);
    });

    it('does not handle a request when approve is omitted', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'request',
        request_type: 'friend',
        flag: 'flag-friend-7',
      }, { remark: 'unused' }, api);

      expect(handle).not.toHaveBeenCalled();
    });

    it('does not handle an unknown request_type', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'request',
        request_type: 'business',
        flag: 'flag-x',
      }, { approve: true }, api);

      expect(handle).not.toHaveBeenCalled();
    });
  });

  describe('combined and ignored operations', () => {
    it('runs reply, delete, ban, then kick in that order', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation(GROUP_MESSAGE, {
        reply: 'bye',
        at_sender: false,
        delete: true,
        ban: true,
        ban_duration: 120,
        kick: true,
        reject_add_request: true,
      }, api);

      expect(handle.mock.calls).toEqual([
        ['send_group_msg', {
          group_id: 314159,
          message: 'bye',
          auto_escape: false,
        }],
        ['delete_msg', { message_id: 424242 }],
        ['set_group_ban', {
          group_id: 314159,
          user_id: 271828,
          duration: 120,
        }],
        ['set_group_kick', {
          group_id: 314159,
          user_id: 271828,
          reject_add_request: true,
        }],
      ]);
    });

    it('does nothing for a non-message non-request event', async () => {
      const { api, handle } = mockApi();

      await executeQuickOperation({
        post_type: 'notice',
        notice_type: 'group_increase',
        group_id: 314159,
        user_id: 271828,
      }, {
        reply: 'x',
        delete: true,
        ban: true,
        kick: true,
        approve: true,
      }, api);

      expect(handle).not.toHaveBeenCalled();
    });

    it('propagates a rejected api.handle call', async () => {
      const { api, handle } = mockApi();
      handle.mockRejectedValueOnce(new Error('send failed'));

      await expect(executeQuickOperation(GROUP_MESSAGE, {
        reply: 'fail',
        at_sender: false,
      }, api)).rejects.toThrow('send failed');
    });
  });
});
