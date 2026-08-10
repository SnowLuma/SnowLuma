import { describe, expect, it } from 'vitest';
import { shouldDispatchGroupMessage } from '../src/event-filter';
import type { GroupMessageFilterConfig, JsonObject } from '../src/types';

function groupMessage(groupId: number): JsonObject {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: 10001,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
  };
}

const privateMessage: JsonObject = {
  post_type: 'message',
  message_type: 'private',
  user_id: 10001,
  message: [{ type: 'text', data: { text: 'hello' } }],
  raw_message: 'hello',
};

const groupNotice: JsonObject = {
  post_type: 'notice',
  notice_type: 'group_increase',
  group_id: 985983966,
  user_id: 10001,
};

const blacklist: GroupMessageFilterConfig = {
  mode: 'blacklist',
  groupIds: [985983966],
};

const whitelist: GroupMessageFilterConfig = {
  mode: 'whitelist',
  groupIds: [985983966],
};

describe('shouldDispatchGroupMessage', () => {
  it('passes every event when the filter is absent', () => {
    expect(shouldDispatchGroupMessage(groupMessage(985983966), undefined)).toBe(true);
  });

  it('blocks matching blacklist groups and passes other groups', () => {
    expect(shouldDispatchGroupMessage(groupMessage(985983966), blacklist)).toBe(false);
    expect(shouldDispatchGroupMessage(groupMessage(787682322), blacklist)).toBe(true);
  });

  it('passes matching whitelist groups and blocks other groups', () => {
    expect(shouldDispatchGroupMessage(groupMessage(985983966), whitelist)).toBe(true);
    expect(shouldDispatchGroupMessage(groupMessage(787682322), whitelist)).toBe(false);
  });

  it('blocks every group message for an empty whitelist', () => {
    expect(shouldDispatchGroupMessage(groupMessage(985983966), {
      mode: 'whitelist',
      groupIds: [],
    })).toBe(false);
  });

  it('does not affect private messages or notice events', () => {
    expect(shouldDispatchGroupMessage(privateMessage, blacklist)).toBe(true);
    expect(shouldDispatchGroupMessage(groupNotice, blacklist)).toBe(true);
  });
});
