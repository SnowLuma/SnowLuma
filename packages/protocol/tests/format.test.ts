import { describe, expect, it } from 'vitest';
import type { JsonObject, JsonValue } from '@snowluma/common/json';
import type { QQEventVariant } from '@snowluma/protocol/events';
import {
  formatEvent,
  formatGroup,
  formatMessageSegments,
  formatReply,
  formatUser,
  type ReplyEventLookup,
} from '@snowluma/protocol/format';
import type { IdentityService } from '@snowluma/protocol/identity-service';

function stubIdentity(opts: {
  groups?: Record<number, { groupName?: string }>;
  members?: Record<string, { card?: string; nickname?: string }>;
  friends?: Record<number, { remark?: string; nickname?: string }>;
} = {}): IdentityService {
  return {
    findGroup: (groupId: number) => opts.groups?.[groupId] ?? null,
    findGroupMember: (groupId: number, uin: number) =>
      opts.members?.[`${groupId}:${uin}`] ?? null,
    findFriend: (uin: number) => opts.friends?.[uin] ?? null,
  } as IdentityService;
}

function throwingIdentity(): IdentityService {
  return {
    findGroup: () => {
      throw new Error('identity unavailable');
    },
    findGroupMember: () => {
      throw new Error('identity unavailable');
    },
    findFriend: () => {
      throw new Error('identity unavailable');
    },
  } as IdentityService;
}

function stubStore(events: Record<number, JsonObject>): ReplyEventLookup {
  return {
    findEvent: (messageId: number) => events[messageId] ?? null,
  };
}

describe('formatGroup', () => {
  it('renders [name(id)] from a cached groupName', () => {
    const identity = stubIdentity({ groups: { 778899: { groupName: '雪夜茶话' } } });
    expect(formatGroup(identity, 778899)).toBe('[雪夜茶话(778899)]');
  });

  it('trims groupName before wrapping', () => {
    const identity = stubIdentity({ groups: { 778899: { groupName: '  雪夜茶话  ' } } });
    expect(formatGroup(identity, 778899)).toBe('[雪夜茶话(778899)]');
  });

  it('falls back to the bare id when groupName is blank after trim', () => {
    const identity = stubIdentity({ groups: { 778899: { groupName: '   ' } } });
    expect(formatGroup(identity, 778899)).toBe('778899');
  });

  it('falls back to the bare id on cache miss', () => {
    expect(formatGroup(stubIdentity(), 778899)).toBe('778899');
  });

  it('maps 0 and other non-positive ids without a roster lookup', () => {
    const identity = stubIdentity({ groups: { 0: { groupName: 'ghost' } } });
    expect(formatGroup(identity, 0)).toBe('0');
    expect(formatGroup(identity, -12)).toBe('-12');
    expect(formatGroup(identity, Number.NaN)).toBe('0');
  });

  it('falls back to the bare id when findGroup throws', () => {
    expect(formatGroup(throwingIdentity(), 778899)).toBe('778899');
  });
});

describe('formatUser', () => {
  it('prefers a group-member card over nickname', () => {
    const identity = stubIdentity({
      members: { '778899:20001': { card: '冬至', nickname: '小满' } },
    });
    expect(formatUser(identity, 778899, 20001)).toBe('[冬至(20001)]');
  });

  it('uses the member nickname when card is empty after trim', () => {
    const identity = stubIdentity({
      members: { '778899:20001': { card: '  ', nickname: '小满' } },
    });
    expect(formatUser(identity, 778899, 20001)).toBe('[小满(20001)]');
  });

  it('skips the member roster when groupId is missing or non-positive', () => {
    const identity = stubIdentity({
      members: { '778899:20001': { card: '冬至' } },
      friends: { 20001: { remark: '谷雨', nickname: '小满' } },
    });
    expect(formatUser(identity, undefined, 20001)).toBe('[谷雨(20001)]');
    expect(formatUser(identity, 0, 20001)).toBe('[谷雨(20001)]');
    expect(formatUser(identity, -3, 20001)).toBe('[谷雨(20001)]');
  });

  it('falls through to the friend nickname when remark is blank', () => {
    const identity = stubIdentity({
      friends: { 30001: { remark: '   ', nickname: '惊蛰' } },
    });
    expect(formatUser(identity, undefined, 30001)).toBe('[惊蛰(30001)]');
  });

  it('uses a friend after a group-member miss', () => {
    const identity = stubIdentity({
      friends: { 20002: { remark: '白露' } },
    });
    expect(formatUser(identity, 778899, 20002)).toBe('[白露(20002)]');
  });

  it('returns the bare uin when nothing is cached', () => {
    expect(formatUser(stubIdentity(), 778899, 20001)).toBe('20001');
  });

  it('returns the uid when uin is missing or non-positive', () => {
    expect(formatUser(stubIdentity(), 778899, 0, 'u_winter')).toBe('u_winter');
    expect(formatUser(stubIdentity(), 778899, -8, 'u_neg')).toBe('u_neg');
  });

  it('returns 0 when both uin and uid are missing', () => {
    expect(formatUser(stubIdentity(), undefined, 0)).toBe('0');
    expect(formatUser(stubIdentity(), undefined, -8)).toBe('0');
  });

  it('returns the bare uin when identity lookups throw', () => {
    expect(formatUser(throwingIdentity(), 778899, 20001)).toBe('20001');
    expect(formatUser(throwingIdentity(), undefined, 20001)).toBe('20001');
  });
});

describe('formatMessageSegments', () => {
  it('renders a raw string and truncates past 50 characters', () => {
    expect(formatMessageSegments('清明')).toBe('清明');
    expect(formatMessageSegments('雨'.repeat(51))).toBe(`${'雨'.repeat(50)}...`);
  });

  it('returns [空消息] for an empty string or a non-array payload', () => {
    expect(formatMessageSegments('')).toBe('[空消息]');
    expect(formatMessageSegments([])).toBe('[空消息]');
    expect(formatMessageSegments(null)).toBe('[空消息]');
    expect(formatMessageSegments(42)).toBe('[空消息]');
    expect(formatMessageSegments({ type: 'text' })).toBe('[空消息]');
  });

  it('skips non-object segments and still joins the rest', () => {
    expect(formatMessageSegments([
      null,
      7,
      'skip',
      ['nested'],
      { type: 'text', data: { text: '立夏' } },
      { type: 'text', data: { text: '小暑' } },
    ])).toBe('立夏 小暑');
  });

  it('treats a missing or non-object data field as empty segment data', () => {
    expect(formatMessageSegments([{ type: 'text' }])).toBe('[空消息]');
    expect(formatMessageSegments([{ type: 'at', data: null }])).toBe('@');
    expect(formatMessageSegments([{ type: 'at', data: ['all'] }])).toBe('@');
    expect(formatMessageSegments([{ type: 'image', data: 'pic' }])).toBe('[图片]');
  });

  it('renders each known segment type with its preview token', () => {
    expect(formatMessageSegments([
      { type: 'text', data: { text: 'hi' } },
      { type: 'image', data: {} },
      { type: 'image', data: { emoji_id: 'e1', summary: '捂脸' } },
      { type: 'image', data: { emoji_id: 'e2' } },
      { type: 'face', data: { id: 1 } },
      { type: 'mface', data: { text: '旺柴' } },
      { type: 'mface', data: {} },
      { type: 'at', data: { qq: 20001 } },
      { type: 'at', data: { qq: 'all' } },
      { type: 'at', data: {} },
      { type: 'reply', data: { id: 4100 } },
      { type: 'reply', data: {} },
      { type: 'record', data: {} },
      { type: 'video', data: {} },
      { type: 'file', data: { name: 'notes.txt' } },
      { type: 'file', data: { file: 'old.bin' } },
      { type: 'file', data: {} },
      { type: 'xml', data: {} },
      { type: 'markdown', data: {} },
      { type: 'inline_keyboard', data: {} },
      { type: 'forward', data: {} },
      { type: 'poke', data: {} },
      { type: 'flash_file', data: { title: '图纸.dwg' } },
      { type: 'flash_file', data: {} },
      { type: 'mystery', data: {} },
      {},
    ])).toBe([
      'hi',
      '[图片]',
      '[捂脸]',
      '[表情]',
      '[表情]',
      '[旺柴]',
      '[表情]',
      '@20001',
      '@全体成员',
      '@',
      '[回复:4100]',
      '[回复:]',
      '[语音]',
      '[视频]',
      '[文件:notes.txt]',
      '[文件:old.bin]',
      '[文件]',
      '[XML]',
      '[Markdown]',
      '[交互按钮]',
      '[聊天记录]',
      '[窗口抖动]',
      '[闪传文件:图纸.dwg]',
      '[闪传文件]',
      '[mystery]',
      '[]',
    ].join(' '));
  });

  it('truncates file names and flash-file titles to 20 characters', () => {
    const longName = 'abcdefghijABCDEFGHIJxyz';
    expect(formatMessageSegments([{ type: 'file', data: { name: longName } }]))
      .toBe('[文件:abcdefghijABCDEFGHIJ...]');
    expect(formatMessageSegments([{ type: 'flash_file', data: { title: longName } }]))
      .toBe('[闪传文件:abcdefghijABCDEFGHIJ...]');
  });

  it('treats an empty file name as absent even if file is also empty', () => {
    expect(formatMessageSegments([{ type: 'file', data: { name: '' } }])).toBe('[文件]');
  });

  it('extracts json card titles from the documented ARK locations in order', () => {
    const ranked = JSON.stringify({
      meta: {
        detail_1: { title: '小程序名' },
        detail: { title: '详情名' },
        news: { title: '新闻名' },
      },
      prompt: '提示文案',
    });
    expect(formatMessageSegments([{ type: 'json', data: { data: ranked } }]))
      .toBe('[卡片:小程序名]');

    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { detail: { title: '图文分享' } } }) },
    }])).toBe('[卡片:图文分享]');

    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { news: { title: '头条' } } }) },
    }])).toBe('[卡片:头条]');

    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { mannonce: { title: '群公告' } } }) },
    }])).toBe('[卡片:群公告]');

    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { music: { title: '夜曲' } } }) },
    }])).toBe('[卡片:夜曲]');

    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { video: { title: '短片' } } }) },
    }])).toBe('[卡片:短片]');
  });

  it('uses the single remaining meta section title when the key is unknown', () => {
    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { share_card: { title: '自定义卡片' } } }) },
    }])).toBe('[卡片:自定义卡片]');
  });

  it('falls back to prompt, then desc, when meta has no usable title', () => {
    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({
        meta: { left: { title: '' }, right: { title: '  ' } },
        prompt: '  请升级客户端  ',
      }) },
    }])).toBe('[卡片:请升级客户端]');

    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ desc: '  简介文案  ' }) },
    }])).toBe('[卡片:简介文案]');
  });

  it('truncates card titles to 30 characters', () => {
    const prompt = '卡'.repeat(31);
    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ prompt }) },
    }])).toBe(`[卡片:${'卡'.repeat(30)}...]`);
  });

  it('falls back to [JSON] when the payload has no extractable title', () => {
    expect(formatMessageSegments([{ type: 'json', data: {} }])).toBe('[JSON]');
    expect(formatMessageSegments([{ type: 'json', data: { data: 1 } }])).toBe('[JSON]');
    expect(formatMessageSegments([{ type: 'json', data: { data: '' } }])).toBe('[JSON]');
    expect(formatMessageSegments([{ type: 'json', data: { data: '{broken' } }])).toBe('[JSON]');
    expect(formatMessageSegments([{ type: 'json', data: { data: 'null' } }])).toBe('[JSON]');
    expect(formatMessageSegments([{ type: 'json', data: { data: '12' } }])).toBe('[JSON]');
    expect(formatMessageSegments([{ type: 'json', data: { data: '[1]' } }])).toBe('[JSON]');
    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: ['x'], prompt: '' }) },
    }])).toBe('[JSON]');
    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { a: { title: 9 }, b: { title: true } } }) },
    }])).toBe('[JSON]');
    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ meta: { only: ['not-object'] } }) },
    }])).toBe('[JSON]');
    expect(formatMessageSegments([{
      type: 'json',
      data: { data: JSON.stringify({ foo: 1 }) },
    }])).toBe('[JSON]');
  });

  it('returns [消息渲染异常] when walking the segment list throws', () => {
    const broken = new Proxy([] as JsonValue[], {
      get(target, prop, receiver) {
        if (prop === Symbol.iterator) throw new Error('segment exploded');
        return Reflect.get(target, prop, receiver);
      },
    });
    expect(formatMessageSegments(broken)).toBe('[消息渲染异常]');
  });
});

describe('formatReply', () => {
  const identity = stubIdentity({
    groups: { 778899: { groupName: '雪夜茶话' } },
    members: { '778899:20001': { card: '冬至' } },
  });

  it('renders [回复:0] when the reply id is missing', () => {
    expect(formatReply(stubStore({}), identity, 0)).toBe('[回复:0]');
    expect(formatReply(stubStore({}), identity, Number.NaN)).toBe('[回复:0]');
  });

  it('renders [回复:<id>] when the store has no matching event', () => {
    expect(formatReply(stubStore({}), identity, 4100)).toBe('[回复:4100]');
  });

  it('resolves a group reply from the identity roster', () => {
    const store = stubStore({
      4100: {
        message_type: 'group',
        group_id: 778899,
        user_id: 20001,
        message: [{ type: 'text', data: { text: '霜降好' } }],
      },
    });
    expect(formatReply(store, identity, 4100)).toBe('[回复 [冬至(20001)]: 霜降好]');
  });

  it('coerces string user_id / group_id and uses the stored sender card on cache miss', () => {
    const store = stubStore({
      4101: {
        message_type: 'group',
        group_id: '778899',
        user_id: '20003',
        sender: { card: '处暑', nickname: 'ignored' },
        message: '晚风',
      },
    });
    expect(formatReply(store, stubIdentity(), 4101)).toBe('[回复 [处暑(20003)]: 晚风]');
  });

  it('does not treat private messages as group and ignores a whitespace-only card', () => {
    const store = stubStore({
      4102: {
        message_type: 'private',
        group_id: 778899,
        user_id: 20001,
        sender: { card: '  ', nickname: '寒露' },
        message: [{ type: 'text', data: { text: '私聊一句' } }],
      },
    });
    // Fallback is `(card || nickname).trim()`: a whitespace card is truthy
    // before trim, so the nickname is not used.
    expect(formatReply(store, stubIdentity(), 4102)).toBe('[回复 20001: 私聊一句]');
  });

  it('uses sender.nickname when card is absent', () => {
    const store = stubStore({
      4102: {
        message_type: 'private',
        user_id: 20001,
        sender: { nickname: '寒露' },
        message: [{ type: 'text', data: { text: '私聊一句' } }],
      },
    });
    expect(formatReply(store, stubIdentity(), 4102)).toBe('[回复 [寒露(20001)]: 私聊一句]');
  });

  it('keeps the bare uin when sender is not a usable object', () => {
    const noSender = stubStore({
      4103: {
        message_type: 'private',
        user_id: 20004,
        sender: null,
        message: 'x',
      },
    });
    expect(formatReply(noSender, stubIdentity(), 4103)).toBe('[回复 20004: x]');

    const arraySender = stubStore({
      4104: {
        message_type: 'private',
        user_id: 20004,
        sender: ['寒露'],
        message: 'y',
      },
    });
    expect(formatReply(arraySender, stubIdentity(), 4104)).toBe('[回复 20004: y]');
  });

  it('maps non-numeric user_id to 0 and skips the sender-name fallback', () => {
    const store = stubStore({
      4105: {
        message_type: 'private',
        user_id: 'not-a-uin',
        sender: { nickname: '不该出现' },
        message: 'z',
      },
    });
    expect(formatReply(store, stubIdentity(), 4105)).toBe('[回复 0: z]');
  });

  it('truncates the body preview to 30 characters after segment rendering', () => {
    const store = stubStore({
      4106: {
        message_type: 'private',
        user_id: 20004,
        message: [{ type: 'text', data: { text: '正'.repeat(80) } }],
      },
    });
    expect(formatReply(store, stubIdentity(), 4106))
      .toBe(`[回复 20004: ${'正'.repeat(30)}...]`);
  });

  it('renders referenced reply segments as tokens instead of recursing', () => {
    const store = stubStore({
      4107: {
        message_type: 'private',
        user_id: 20004,
        message: [{ type: 'reply', data: { id: 1 } }, { type: 'text', data: { text: '外层' } }],
      },
    });
    expect(formatReply(store, stubIdentity(), 4107)).toBe('[回复 20004: [回复:1] 外层]');
  });

  it('returns [回复:<id>] when findEvent throws', () => {
    const store: ReplyEventLookup = {
      findEvent: () => {
        throw new Error('store unavailable');
      },
    };
    expect(formatReply(store, identity, 4100)).toBe('[回复:4100]');
  });
});

describe('formatEvent', () => {
  const identity = stubIdentity({
    groups: { 778899: { groupName: '雪夜茶话' } },
    members: {
      '778899:20001': { card: '冬至' },
      '778899:20002': { card: '小满' },
      '778899:20003': { nickname: '谷雨' },
    },
    friends: {
      30001: { nickname: '惊蛰' },
      30002: { remark: '白露' },
    },
  });

  it('returns null for kinds that have dedicated message-log paths', () => {
    expect(formatEvent(identity, { kind: 'group_message' } as QQEventVariant)).toBeNull();
    expect(formatEvent(identity, { kind: 'friend_message' } as QQEventVariant)).toBeNull();
    expect(formatEvent(identity, { kind: 'temp_message' } as QQEventVariant)).toBeNull();
    expect(formatEvent(identity, { kind: 'group_file_upload' } as QQEventVariant)).toBeNull();
    expect(formatEvent(identity, { kind: 'friend_add' } as QQEventVariant)).toBeNull();
  });

  it('returns null for kinds with no notice-line renderer', () => {
    expect(formatEvent(identity, { kind: 'bot_offline' } as QQEventVariant)).toBeNull();
    expect(formatEvent(identity, { kind: 'ptt_trans_result' } as QQEventVariant)).toBeNull();
    expect(formatEvent(identity, { kind: 'group_card_change' } as QQEventVariant)).toBeNull();
    expect(formatEvent(identity, { kind: 'friend_input_status' } as QQEventVariant)).toBeNull();
  });

  it('renders group_recall', () => {
    expect(formatEvent(identity, {
      kind: 'group_recall',
      groupId: 778899,
      authorUin: 20001,
      operatorUin: 20002,
    } as QQEventVariant)).toBe('群撤回 [雪夜茶话(778899)] | [冬至(20001)] 被 [小满(20002)] 撤回');
  });

  it('renders friend_recall', () => {
    expect(formatEvent(identity, {
      kind: 'friend_recall',
      userUin: 30001,
    } as QQEventVariant)).toBe('私聊撤回 [惊蛰(30001)] 撤回了消息');
  });

  it('renders group_member_join including a uid-only joiner', () => {
    expect(formatEvent(identity, {
      kind: 'group_member_join',
      groupId: 778899,
      userUin: 20003,
      userUid: 'u_guyu',
    } as QQEventVariant)).toBe('入群 [谷雨(20003)] 加入 [雪夜茶话(778899)]');

    expect(formatEvent(identity, {
      kind: 'group_member_join',
      groupId: 778899,
      userUin: 0,
      userUid: 'u_only',
    } as QQEventVariant)).toBe('入群 u_only 加入 [雪夜茶话(778899)]');
  });

  it('renders group_member_leave for leave, kick, and disband', () => {
    expect(formatEvent(identity, {
      kind: 'group_member_leave',
      groupId: 778899,
      userUin: 20001,
      leaveType: 'leave',
    } as QQEventVariant)).toBe('退群 [冬至(20001)] 退出 [雪夜茶话(778899)]');

    expect(formatEvent(identity, {
      kind: 'group_member_leave',
      groupId: 778899,
      userUin: 20001,
      leaveType: 'kick',
    } as QQEventVariant)).toBe('退群 [冬至(20001)] 被踢出 [雪夜茶话(778899)]');

    expect(formatEvent(identity, {
      kind: 'group_member_leave',
      groupId: 778899,
      userUin: 20001,
      leaveType: 'disband',
    } as QQEventVariant)).toBe('退群 [冬至(20001)] 随群解散 [雪夜茶话(778899)]');
  });

  it('renders group_mute with the duration in seconds', () => {
    expect(formatEvent(identity, {
      kind: 'group_mute',
      groupId: 778899,
      userUin: 20001,
      duration: 600,
    } as QQEventVariant)).toBe('禁言 [雪夜茶话(778899)] | [冬至(20001)] 600秒');
  });

  it('renders group_admin set and unset', () => {
    expect(formatEvent(identity, {
      kind: 'group_admin',
      groupId: 778899,
      userUin: 20002,
      set: true,
    } as QQEventVariant)).toBe('管理 [雪夜茶话(778899)] | [小满(20002)] +管理员');

    expect(formatEvent(identity, {
      kind: 'group_admin',
      groupId: 778899,
      userUin: 20002,
      set: false,
    } as QQEventVariant)).toBe('管理 [雪夜茶话(778899)] | [小满(20002)] -管理员');
  });

  it('renders friend_poke and group_poke', () => {
    expect(formatEvent(identity, {
      kind: 'friend_poke',
      peerUin: 30001,
      senderUin: 30002,
      targetUin: 30001,
    } as QQEventVariant)).toBe('私聊戳 [惊蛰(30001)] | [白露(30002)] -> [惊蛰(30001)]');

    expect(formatEvent(identity, {
      kind: 'group_poke',
      groupId: 778899,
      userUin: 20001,
      targetUin: 20002,
    } as QQEventVariant)).toBe('群戳 [雪夜茶话(778899)] | [冬至(20001)] -> [小满(20002)]');
  });

  it('renders friend_request and group_invite', () => {
    expect(formatEvent(identity, {
      kind: 'friend_request',
      fromUin: 30002,
      message: '加个好友',
    } as QQEventVariant)).toBe('好友请求 [白露(30002)]: 加个好友');

    expect(formatEvent(identity, {
      kind: 'group_invite',
      fromUin: 30001,
      groupId: 778899,
    } as QQEventVariant)).toBe('群邀请 [惊蛰(30001)] -> [雪夜茶话(778899)]');
  });

  it('renders group_essence set and unset', () => {
    expect(formatEvent(identity, {
      kind: 'group_essence',
      groupId: 778899,
      set: true,
    } as QQEventVariant)).toBe('精华 [雪夜茶话(778899)] | +精华');

    expect(formatEvent(identity, {
      kind: 'group_essence',
      groupId: 778899,
      set: false,
    } as QQEventVariant)).toBe('精华 [雪夜茶话(778899)] | -精华');
  });

  it('renders group_msg_emoji_like add and remove', () => {
    expect(formatEvent(identity, {
      kind: 'group_msg_emoji_like',
      groupId: 778899,
      operatorUin: 20001,
      operatorUid: 'u_dongzhi',
      emojiId: '76',
      msgSeq: 8801,
      isAdd: true,
    } as QQEventVariant)).toBe('表情回应 [雪夜茶话(778899)] | [冬至(20001)] +[76] msgSeq=8801');

    expect(formatEvent(identity, {
      kind: 'group_msg_emoji_like',
      groupId: 778899,
      operatorUin: 0,
      operatorUid: 'u_dongzhi',
      emojiId: 'ok',
      msgSeq: 8802,
      isAdd: false,
    } as QQEventVariant)).toBe('表情回应 [雪夜茶话(778899)] | u_dongzhi -[ok] msgSeq=8802');
  });

  it('degrades to numeric ids when the roster is empty', () => {
    expect(formatEvent(stubIdentity(), {
      kind: 'group_recall',
      groupId: 778899,
      authorUin: 20001,
      operatorUin: 20002,
    } as QQEventVariant)).toBe('群撤回 778899 | 20001 被 20002 撤回');
  });

  it('returns null when reading the event kind throws', () => {
    const broken = {
      get kind() {
        throw new Error('event exploded');
      },
    } as unknown as QQEventVariant;
    expect(formatEvent(identity, broken)).toBeNull();
  });
});
