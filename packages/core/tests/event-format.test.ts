// Tests for utils/event-format.ts.
//
// Each formatter is defensive about cache misses / malformed input —
// these tests cover both the happy paths (resolves names from
// Identity / MessageStore) and the degraded paths (falls back to the
// raw uin / groupId without crashing).

import { describe, expect, it } from 'vitest';
import {
  formatEvent,
  formatGroup,
  formatMessageSegments,
  formatReply,
  formatUser,
} from '@snowluma/protocol/format';
import type { QQEventVariant } from '@snowluma/protocol/events';

// ─── Test fakes (just the find* surface event-format uses) ───

function fakeIdentity(opts: {
  groups?: Record<number, { groupName: string }>;
  members?: Record<string, { uin: number; card?: string; nickname?: string }>;
  friends?: Record<number, { uin: number; nickname?: string; remark?: string }>;
} = {}): any {
  return {
    findGroup: (gid: number) => opts.groups?.[gid] ?? null,
    findGroupMember: (gid: number, uin: number) => opts.members?.[`${gid}/${uin}`] ?? null,
    findFriend: (uin: number) => opts.friends?.[uin] ?? null,
  };
}

function fakeMessageStore(events: Record<number, Record<string, unknown>>): any {
  return {
    findEvent: (id: number) => events[id] ?? null,
  };
}

describe('formatGroup', () => {
  it('renders [groupName(id)] when the group is in cache', () => {
    const id = fakeIdentity({ groups: { 123: { groupName: 'TestGroup' } } });
    expect(formatGroup(id, 123)).toBe('[TestGroup(123)]');
  });

  it('falls back to bare id on cache miss', () => {
    const id = fakeIdentity();
    expect(formatGroup(id, 123)).toBe('123');
  });

  it('handles 0 / missing group id without crashing', () => {
    const id = fakeIdentity();
    expect(formatGroup(id, 0)).toBe('0');
  });

  it('falls back to bare id if findGroup throws', () => {
    const id = { findGroup: () => { throw new Error('db dead'); } } as any;
    expect(formatGroup(id, 123)).toBe('123');
  });
});

describe('formatUser', () => {
  it('prefers group-member card over nickname', () => {
    const id = fakeIdentity({ members: { '1/100': { uin: 100, card: 'Card', nickname: 'Nick' } } });
    expect(formatUser(id, 1, 100)).toBe('[Card(100)]');
  });

  it('falls back to nickname when card is empty', () => {
    const id = fakeIdentity({ members: { '1/100': { uin: 100, card: '', nickname: 'Nick' } } });
    expect(formatUser(id, 1, 100)).toBe('[Nick(100)]');
  });

  it('falls back to friend list when not a group member', () => {
    const id = fakeIdentity({ friends: { 100: { uin: 100, nickname: 'FriendNick' } } });
    expect(formatUser(id, undefined, 100)).toBe('[FriendNick(100)]');
  });

  it('prefers friend remark over nickname', () => {
    const id = fakeIdentity({ friends: { 100: { uin: 100, nickname: 'A', remark: 'B' } } });
    expect(formatUser(id, undefined, 100)).toBe('[B(100)]');
  });

  it('falls back to uin on full cache miss', () => {
    const id = fakeIdentity();
    expect(formatUser(id, 1, 100)).toBe('100');
  });

  it('falls back to uid when only uid is available', () => {
    const id = fakeIdentity();
    expect(formatUser(id, undefined, 0, 'u_abc')).toBe('u_abc');
  });
});

describe('formatMessageSegments', () => {
  it('renders text segments and truncates beyond 50 chars', () => {
    const long = 'a'.repeat(80);
    expect(formatMessageSegments([{ type: 'text', data: { text: long } }]))
      .toBe(`${'a'.repeat(50)}...`);
  });

  it('handles known media types and at/reply', () => {
    const out = formatMessageSegments([
      { type: 'text', data: { text: 'hi' } },
      { type: 'image', data: {} },
      { type: 'at', data: { qq: 12345 } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'reply', data: { id: 999 } },
      { type: 'face', data: {} },
      { type: 'video', data: {} },
      { type: 'record', data: {} },
    ]);
    expect(out).toBe('hi [图片] @12345 @全体成员 [回复:999] [表情] [视频] [语音]');
  });

  it('renders file segments using data.name (the OneBot field), with data.file fallback', () => {
    expect(formatMessageSegments([{ type: 'file', data: { name: '20260606_151113.wav' } }]))
      .toBe('[文件:20260606_151113.wav]');
    expect(formatMessageSegments([{ type: 'file', data: { file: 'legacy.bin' } }]))
      .toBe('[文件:legacy.bin]');
    expect(formatMessageSegments([{ type: 'file', data: {} }]))
      .toBe('[文件]');
  });

  it('renders unknown segment types as [type]', () => {
    expect(formatMessageSegments([{ type: 'something_new', data: {} }]))
      .toBe('[something_new]');
  });

  it('renders a string message as text (truncated)', () => {
    expect(formatMessageSegments('hello')).toBe('hello');
    expect(formatMessageSegments('a'.repeat(60))).toBe(`${'a'.repeat(50)}...`);
  });

  it('returns [空消息] for empty arrays / non-array / null', () => {
    expect(formatMessageSegments([])).toBe('[空消息]');
    expect(formatMessageSegments(null as any)).toBe('[空消息]');
    expect(formatMessageSegments({} as any)).toBe('[空消息]');
  });
});

describe('formatReply', () => {
  it('renders the resolved sender + body preview when the original is in the store', () => {
    const store = fakeMessageStore({
      42: {
        message_type: 'group',
        group_id: 1,
        user_id: 100,
        sender: { card: 'OrigSender' },
        message: [{ type: 'text', data: { text: '早安' } }],
      },
    });
    const id = fakeIdentity({ members: { '1/100': { uin: 100, card: 'OrigSender' } } });
    expect(formatReply(store, id, 42)).toBe('[回复 [OrigSender(100)]: 早安]');
  });

  it('falls back to [回复:<id>] when the original is missing', () => {
    const store = fakeMessageStore({});
    const id = fakeIdentity();
    expect(formatReply(store, id, 9999)).toBe('[回复:9999]');
  });

  it('uses the sender baked into the stored event when cache misses', () => {
    const store = fakeMessageStore({
      42: {
        message_type: 'private',
        user_id: 100,
        sender: { nickname: 'StoredNick' },
        message: [{ type: 'text', data: { text: 'hi' } }],
      },
    });
    const id = fakeIdentity(); // no cache
    expect(formatReply(store, id, 42)).toBe('[回复 [StoredNick(100)]: hi]');
  });

  it('truncates the body preview to 30 chars', () => {
    const store = fakeMessageStore({
      42: {
        message_type: 'private',
        user_id: 100,
        sender: { nickname: 'X' },
        message: [{ type: 'text', data: { text: 'a'.repeat(80) } }],
      },
    });
    const id = fakeIdentity();
    const out = formatReply(store, id, 42);
    // Inner text gets truncated to 50 by formatMessageSegments, then to 30 here
    expect(out).toContain('...');
    expect(out.length).toBeLessThan(80);
  });

  it('returns the fallback when findEvent throws', () => {
    const store = { findEvent: () => { throw new Error('store dead'); } } as any;
    const id = fakeIdentity();
    expect(formatReply(store, id, 42)).toBe('[回复:42]');
  });
});

describe('formatEvent', () => {
  const id = fakeIdentity({
    groups: { 1: { groupName: 'Grp' } },
    members: {
      '1/100': { uin: 100, card: 'Alice' },
      '1/200': { uin: 200, card: 'Bob' },
      '1/300': { uin: 300, nickname: 'Carol' },
    },
    friends: {
      500: { uin: 500, nickname: 'FriendA' },
      600: { uin: 600, nickname: 'FriendB' },
    },
  });

  it('returns null for kinds rendered elsewhere', () => {
    expect(formatEvent(id, { kind: 'group_message' } as QQEventVariant)).toBeNull();
    expect(formatEvent(id, { kind: 'friend_message' } as QQEventVariant)).toBeNull();
    expect(formatEvent(id, { kind: 'temp_message' } as QQEventVariant)).toBeNull();
  });

  it('renders group_recall with all three name slots', () => {
    expect(formatEvent(id, {
      kind: 'group_recall',
      groupId: 1, authorUin: 100, operatorUin: 200,
    } as QQEventVariant))
      .toBe('群撤回 [Grp(1)] | [Alice(100)] 被 [Bob(200)] 撤回');
  });

  it('renders group_member_join with group name and joiner', () => {
    expect(formatEvent(id, {
      kind: 'group_member_join',
      groupId: 1, userUin: 300, userUid: '',
    } as QQEventVariant))
      .toBe('入群 [Carol(300)] 加入 [Grp(1)]');
  });

  it('renders group_poke with both endpoints', () => {
    expect(formatEvent(id, {
      kind: 'group_poke',
      groupId: 1, userUin: 100, targetUin: 200,
    } as QQEventVariant))
      .toBe('群戳 [Grp(1)] | [Alice(100)] -> [Bob(200)]');
  });

  it('renders friend_poke without group context', () => {
    expect(formatEvent(id, {
      kind: 'friend_poke',
      userUin: 500, targetUin: 600,
    } as QQEventVariant))
      .toBe('戳一戳 [FriendA(500)] -> [FriendB(600)]');
  });

  it('degrades to numeric IDs when nothing is cached', () => {
    const empty = fakeIdentity();
    expect(formatEvent(empty, {
      kind: 'group_recall',
      groupId: 1, authorUin: 100, operatorUin: 200,
    } as QQEventVariant))
      .toBe('群撤回 1 | 100 被 200 撤回');
  });
});
