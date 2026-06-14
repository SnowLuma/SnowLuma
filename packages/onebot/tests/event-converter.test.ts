import { describe, expect, it } from 'vitest';
import {
  convertEvent,
  elementsToOneBotSegments,
  type ConverterContext,
} from '../src/event-converter';
import {
  buildDispatchPayload,
  pickDispatchJson,
  resolveReportOptions,
  shapeEventForAdapter,
} from '../src/event-filter';
import type {
  FriendMessage,
  GroupMessage,
  MessageElement,
  QQEventVariant,
  TempMessage,
} from '@snowluma/protocol/events';

const SELF_ID = 10001;
const PEER_UIN = 22222;
const GROUP_ID = 99999;

/** Minimal ConverterContext with no resolvers (all null). Per-test
 *  helpers override individual fields when they need a stub. */
function bareCtx(overrides: Partial<ConverterContext> = {}): ConverterContext {
  return {
    selfId: SELF_ID,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: null,
    mediaSegmentSink: null,
    ...overrides,
  };
}

function makeFriendMessage(senderUin: number): FriendMessage {
  return {
    kind: 'friend_message',
    time: 1700000000,
    selfUin: SELF_ID,
    senderUin,
    senderNick: senderUin === SELF_ID ? 'me' : 'peer',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

function makeGroupMessage(senderUin: number): GroupMessage {
  return {
    kind: 'group_message',
    time: 1700000000,
    selfUin: SELF_ID,
    groupId: 99999,
    senderUin,
    senderNick: senderUin === SELF_ID ? 'me' : 'peer',
    senderCard: '',
    senderRole: 'member',
    msgSeq: 1,
    msgId: 1,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

function makeTempMessage(senderUin: number): TempMessage {
  return {
    kind: 'temp_message',
    time: 1700000000,
    selfUin: SELF_ID,
    senderUin,
    groupId: 99999,
    senderNick: senderUin === SELF_ID ? 'me' : 'peer',
    msgSeq: 1,
    elements: [{ type: 'text', text: 'hi' }],
  };
}

describe('convertEvent — message kinds', () => {
  it('friend_message peer → post_type "message", sub_type "friend"', async () => {
    const out = await convertEvent(bareCtx(), makeFriendMessage(PEER_UIN));
    expect(out).not.toBeNull();
    expect(out!.post_type).toBe('message');
    expect(out!.message_type).toBe('private');
    expect(out!.sub_type).toBe('friend');
    expect(out!.user_id).toBe(PEER_UIN);
    expect(out!.self_id).toBe(SELF_ID);
    expect(out!.raw_message).toBe('hi');
  });

  it('friend_message self → post_type "message_sent"', async () => {
    const out = await convertEvent(bareCtx(), makeFriendMessage(SELF_ID));
    expect(out!.post_type).toBe('message_sent');
  });

  it('group_message peer → post_type "message", sub_type "normal", group_id set', async () => {
    const out = await convertEvent(bareCtx(), makeGroupMessage(PEER_UIN));
    expect(out!.post_type).toBe('message');
    expect(out!.message_type).toBe('group');
    expect(out!.sub_type).toBe('normal');
    expect(out!.group_id).toBe(GROUP_ID);
  });

  it('group_message self → post_type "message_sent"', async () => {
    const out = await convertEvent(bareCtx(), makeGroupMessage(SELF_ID));
    expect(out!.post_type).toBe('message_sent');
  });

  it('temp_message peer → post_type "message", sub_type "group"', async () => {
    const out = await convertEvent(bareCtx(), makeTempMessage(PEER_UIN));
    expect(out!.post_type).toBe('message');
    expect(out!.sub_type).toBe('group');
  });

  it('temp_message self → post_type "message_sent"', async () => {
    const out = await convertEvent(bareCtx(), makeTempMessage(SELF_ID));
    expect(out!.post_type).toBe('message_sent');
    expect(out!.sub_type).toBe('group');
  });

  it('messageIdResolver overrides the raw msgSeq', async () => {
    const ctx = bareCtx({ messageIdResolver: (_g, _s, seq) => seq * 10 });
    const out = await convertEvent(ctx, makeFriendMessage(PEER_UIN));
    expect(out!.message_id).toBe(10);
  });
});

describe('convertEvent — notice kinds', () => {
  it('group_member_join: same-actor approve, else invite', async () => {
    const approve = await convertEvent(bareCtx(), {
      kind: 'group_member_join',
      time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, operatorUin: PEER_UIN,
    } as QQEventVariant);
    expect(approve!.notice_type).toBe('group_increase');
    expect(approve!.sub_type).toBe('approve');

    const invite = await convertEvent(bareCtx(), {
      kind: 'group_member_join',
      time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, operatorUin: 33333,
    } as QQEventVariant);
    expect(invite!.sub_type).toBe('invite');
  });

  it('group_member_leave: leave / kick / kick_me / disband', async () => {
    const leave = await convertEvent(bareCtx(), {
      kind: 'group_member_leave',
      time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, operatorUin: 0, leaveType: 'leave',
    } as QQEventVariant);
    expect(leave!.sub_type).toBe('leave');

    const kick = await convertEvent(bareCtx(), {
      kind: 'group_member_leave',
      time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, operatorUin: 33333, leaveType: 'kick',
    } as QQEventVariant);
    expect(kick!.sub_type).toBe('kick');

    const kickMe = await convertEvent(bareCtx(), {
      kind: 'group_member_leave',
      time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: SELF_ID, operatorUin: 33333, leaveType: 'kick',
    } as QQEventVariant);
    expect(kickMe!.sub_type).toBe('kick_me');

    const disband = await convertEvent(bareCtx(), {
      kind: 'group_member_leave',
      time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: SELF_ID, operatorUin: 33333, leaveType: 'disband',
    } as QQEventVariant);
    expect(disband!.sub_type).toBe('disband');
  });

  it('group_mute: ban vs lift_ban driven by duration', async () => {
    const ban = await convertEvent(bareCtx(), {
      kind: 'group_mute', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, operatorUin: 33333, duration: 600,
    } as QQEventVariant);
    expect(ban!.sub_type).toBe('ban');
    expect(ban!.duration).toBe(600);

    const lift = await convertEvent(bareCtx(), {
      kind: 'group_mute', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, operatorUin: 33333, duration: 0,
    } as QQEventVariant);
    expect(lift!.sub_type).toBe('lift_ban');
  });

  it('group_admin: set vs unset', async () => {
    const set = await convertEvent(bareCtx(), {
      kind: 'group_admin', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, set: true,
    } as QQEventVariant);
    expect(set!.notice_type).toBe('group_admin');
    expect(set!.sub_type).toBe('set');

    const unset = await convertEvent(bareCtx(), {
      kind: 'group_admin', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, set: false,
    } as QQEventVariant);
    expect(unset!.sub_type).toBe('unset');
  });

  it('friend_recall: passes through user + sequence-as-message_id', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'friend_recall', time: 1, selfUin: SELF_ID,
      userUin: PEER_UIN, msgSeq: 77,
    } as QQEventVariant);
    expect(out!.notice_type).toBe('friend_recall');
    expect(out!.user_id).toBe(PEER_UIN);
    expect(out!.message_id).toBe(77);
  });

  it('group_recall: carries operator, author, message_id', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'group_recall', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      operatorUin: 33333, authorUin: PEER_UIN, msgSeq: 99,
    } as QQEventVariant);
    expect(out!.notice_type).toBe('group_recall');
    expect(out!.operator_id).toBe(33333);
    expect(out!.user_id).toBe(PEER_UIN);
    expect(out!.message_id).toBe(99);
  });

  it('friend_poke: notice/notify/poke with target_id + action fields', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'friend_poke', time: 1, selfUin: SELF_ID,
      userUin: PEER_UIN, targetUin: SELF_ID,
      action: '戳了戳', suffix: '一下', actionImgUrl: 'http://x',
    } as QQEventVariant);
    expect(out!.notice_type).toBe('notify');
    expect(out!.sub_type).toBe('poke');
    expect(out!.target_id).toBe(SELF_ID);
    expect(out!.action).toBe('戳了戳');
  });

  it('group_poke: same shape as friend_poke + group_id', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'group_poke', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, targetUin: SELF_ID,
      action: '戳', suffix: '', actionImgUrl: '',
    } as QQEventVariant);
    expect(out!.notice_type).toBe('notify');
    expect(out!.sub_type).toBe('poke');
    expect(out!.group_id).toBe(GROUP_ID);
  });

  it('group_essence: add vs delete + carries random + sequence', async () => {
    const add = await convertEvent(bareCtx(), {
      kind: 'group_essence', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      senderUin: PEER_UIN, operatorUin: 33333, msgSeq: 50, random: 123,
      set: true,
    } as QQEventVariant);
    expect(add!.notice_type).toBe('essence');
    expect(add!.sub_type).toBe('add');
    expect(add!.random).toBe(123);
    expect(add!.message_seq).toBe(50);

    const del = await convertEvent(bareCtx(), {
      kind: 'group_essence', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      senderUin: PEER_UIN, operatorUin: 33333, msgSeq: 50, random: 123,
      set: false,
    } as QQEventVariant);
    expect(del!.sub_type).toBe('delete');
  });

  it('group_file_upload: emits group_upload with file metadata', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'group_file_upload', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      userUin: PEER_UIN, fileId: 'f1', fileName: 'doc.txt',
      fileSize: 1024, busId: 102,
    } as QQEventVariant);
    expect(out!.notice_type).toBe('group_upload');
    expect((out!.file as Record<string, unknown>).id).toBe('f1');
    expect((out!.file as Record<string, unknown>).size).toBe(1024);
  });

  it('friend_add: emits friend_add notice', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'friend_add', time: 1, selfUin: SELF_ID, userUin: PEER_UIN,
    } as QQEventVariant);
    expect(out!.notice_type).toBe('friend_add');
    expect(out!.user_id).toBe(PEER_UIN);
  });
});

describe('convertEvent — request kinds', () => {
  it('friend_request: request/friend with comment + flag', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'friend_request', time: 1, selfUin: SELF_ID,
      fromUin: PEER_UIN, message: '加个好友', flag: 'flag-abc',
    } as QQEventVariant);
    expect(out!.post_type).toBe('request');
    expect(out!.request_type).toBe('friend');
    expect(out!.comment).toBe('加个好友');
    expect(out!.flag).toBe('flag-abc');
  });

  it('group_invite: request/group with sub_type defaulting to "invite"', async () => {
    const out = await convertEvent(bareCtx(), {
      kind: 'group_invite', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      fromUin: PEER_UIN, message: '邀请', flag: 'gflag', subType: '',
    } as QQEventVariant);
    expect(out!.post_type).toBe('request');
    expect(out!.request_type).toBe('group');
    expect(out!.sub_type).toBe('invite');

    const withSubType = await convertEvent(bareCtx(), {
      kind: 'group_invite', time: 1, selfUin: SELF_ID, groupId: GROUP_ID,
      fromUin: PEER_UIN, message: '', flag: 'gflag', subType: 'add',
    } as QQEventVariant);
    expect(withSubType!.sub_type).toBe('add');
  });
});

describe('convertEvent — message elements (13 segment types)', () => {
  // Round-trips one element through elementsToOneBotSegments and
  // asserts the OneBot segment shape. Resolvers are wired only when
  // the element type needs them. JsonArray's index type is JsonValue
  // (a union); cast back to the segment shape so test bodies can read
  // `.type` and `.data` without typeguarding every line.
  type Segment = { type: string; data: Record<string, unknown> };
  async function segment(element: MessageElement, opts: Partial<ConverterContext> = {}): Promise<Segment> {
    const ctx = bareCtx(opts);
    const segments = await elementsToOneBotSegments(
      [element], false, PEER_UIN,
      ctx.imageUrlResolver, ctx.mediaUrlResolver, ctx.messageIdResolver, ctx.mediaSegmentSink,
    );
    return segments[0] as unknown as Segment;
  }

  it('text -> { type:"text", data:{ text } }', async () => {
    const seg = await segment({ type: 'text', text: 'hello' });
    expect(seg).toEqual({ type: 'text', data: { text: 'hello' } });
  });

  it('face -> { type:"face", data:{ id: stringified } }', async () => {
    const seg = await segment({ type: 'face', faceId: 12 });
    expect(seg).toEqual({ type: 'face', data: { id: '12' } });
  });

  it('image: uses imageUrlResolver when wired, falls back to element.imageUrl', async () => {
    const seg = await segment(
      { type: 'image', fileId: 'fid', imageUrl: 'http://fallback' },
      { imageUrlResolver: () => 'http://resolved' },
    );
    expect(seg.type).toBe('image');
    expect((seg.data as Record<string, unknown>).url).toBe('http://resolved');
    expect((seg.data as Record<string, unknown>).file).toBe('fid');
    expect((seg.data as Record<string, unknown>).sub_type).toBe(0);
    expect((seg.data as Record<string, unknown>).summary).toBe('');
  });

  it('image without resolver uses element.imageUrl', async () => {
    const seg = await segment({ type: 'image', fileId: 'fid', imageUrl: 'http://x' });
    expect((seg.data as Record<string, unknown>).url).toBe('http://x');
  });

  it('image: forwards optional sub_type and summary for custom emoji/stickers', async () => {
    const seg = await segment({
      type: 'image',
      fileId: 'fid',
      imageUrl: 'http://x',
      subType: 1,
      summary: '[动画表情]',
    });
    expect(seg).toEqual({
      type: 'image',
      data: {
        url: 'http://x',
        file: 'fid',
        sub_type: 1,
        summary: '[动画表情]',
      },
    });
  });

  it('at: targetUin -> qq string', async () => {
    const seg = await segment({ type: 'at', targetUin: PEER_UIN });
    expect(seg).toEqual({ type: 'at', data: { qq: String(PEER_UIN) } });
  });

  it('at all: uid="all" -> qq:"all"', async () => {
    const seg = await segment({ type: 'at', uid: 'all', targetUin: 0 });
    expect((seg.data as Record<string, unknown>).qq).toBe('all');
  });

  it('reply: replySeq is resolved through messageIdResolver when wired', async () => {
    const seg = await segment(
      { type: 'reply', replySeq: 5 },
      { messageIdResolver: () => 9999 },
    );
    expect(seg).toEqual({ type: 'reply', data: { id: '9999' } });
  });

  it('reply: replySeq=0 -> id "0", no resolver call', async () => {
    let resolverCalls = 0;
    const seg = await segment(
      { type: 'reply', replySeq: 0 },
      { messageIdResolver: () => { resolverCalls++; return 1; } },
    );
    expect((seg.data as Record<string, unknown>).id).toBe('0');
    expect(resolverCalls).toBe(0);
  });

  it('record: uses mediaUrlResolver for url', async () => {
    const seg = await segment(
      { type: 'record', fileName: 'a.silk', fileId: 'fid', url: 'fallback' },
      { mediaUrlResolver: async () => 'resolved' },
    );
    expect(seg.type).toBe('record');
    expect((seg.data as Record<string, unknown>).url).toBe('resolved');
    expect((seg.data as Record<string, unknown>).file).toBe('a.silk');
  });

  it('video: same shape as record', async () => {
    const seg = await segment(
      { type: 'video', fileName: 'a.mp4', fileId: 'fid', url: 'fallback' },
      { mediaUrlResolver: async () => 'resolved' },
    );
    expect(seg.type).toBe('video');
    expect((seg.data as Record<string, unknown>).url).toBe('resolved');
  });

  it('json: text is forwarded as data.data', async () => {
    const seg = await segment({ type: 'json', text: '{"a":1}' });
    expect(seg).toEqual({ type: 'json', data: { data: '{"a":1}' } });
  });

  it('xml: text + resid (defaults to 35)', async () => {
    const seg = await segment({ type: 'xml', text: '<x/>' });
    expect((seg.data as Record<string, unknown>).resid).toBe(35);

    const seg2 = await segment({ type: 'xml', text: '<x/>', subType: 50 });
    expect((seg2.data as Record<string, unknown>).resid).toBe(50);
  });

  it('file: canonical file/file_id/file_size + legacy name/size/id + url + file_hash', async () => {
    const seg = await segment(
      { type: 'file', fileName: 'doc.pdf', fileSize: 7, fileId: 'fid', fileHash: 'h' },
      { mediaUrlResolver: async () => 'http://download' },
    );
    expect(seg.type).toBe('file');
    expect(seg.data).toEqual({
      // NapCat/LLOneBot-style canonical fields
      file: 'doc.pdf', file_id: 'fid', file_size: 7,
      // legacy SnowLuma fields
      name: 'doc.pdf', size: 7, id: 'fid',
      url: 'http://download', file_hash: 'h',
    });
  });

  it('mface: unified to an image segment carrying market-face markers', async () => {
    const emojiId = '235a82d9c0acd2e2db6e0b94e1a1c4f3';
    const seg = await segment({
      type: 'mface', text: '可爱', emojiId, emojiPackageId: 12, emojiKey: 'abc',
    });
    expect(seg).toEqual({
      type: 'image',
      data: {
        file: `23-${emojiId}.gif`,
        url: `https://gxh.vip.qq.com/club/item/parcel/item/23/${emojiId}/raw300.gif`,
        summary: '可爱',
        sub_type: 0,
        emoji_id: emojiId,
        emoji_package_id: 12,
        key: 'abc',
      },
    });
  });

  it('poke: subType forwarded as data.type', async () => {
    const seg = await segment({ type: 'poke', subType: 3 });
    expect(seg).toEqual({ type: 'poke', data: { type: 3 } });
  });

  it('mediaSegmentSink fires once per image/record/video segment', async () => {
    const calls: string[] = [];
    const sink = (mediaType: string) => { calls.push(mediaType); };
    const ctx = bareCtx({
      mediaSegmentSink: sink as ConverterContext['mediaSegmentSink'],
      mediaUrlResolver: async () => '',
    });
    await elementsToOneBotSegments(
      [
        { type: 'image', fileId: 'i', imageUrl: '' },
        { type: 'record', fileName: 'r.silk', fileId: 'r' },
        { type: 'video', fileName: 'v.mp4', fileId: 'v' },
        { type: 'text', text: 'not media' },
      ],
      true, GROUP_ID,
      ctx.imageUrlResolver, ctx.mediaUrlResolver, ctx.messageIdResolver, ctx.mediaSegmentSink,
    );
    expect(calls).toEqual(['image', 'record', 'video']);
  });
});

describe('shapeEventForAdapter', () => {
  const baseEvent = {
    time: 1,
    self_id: SELF_ID,
    post_type: 'message_sent' as const,
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7,
    user_id: SELF_ID,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: SELF_ID, nickname: 'me', sex: 'unknown', age: 0 },
  };

  it('drops self message_sent when adapter has reportSelfMessage=false', () => {
    const opts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: false });
    expect(shapeEventForAdapter(baseEvent, opts)).toBeNull();
  });

  it('keeps self message_sent when adapter has reportSelfMessage=true', () => {
    const opts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: true });
    const shaped = shapeEventForAdapter(baseEvent, opts);
    expect(shaped).not.toBeNull();
    expect(shaped!.post_type).toBe('message_sent');
  });

  it('rewrites message to CQ string when format=string', () => {
    const opts = resolveReportOptions({ messageFormat: 'string', reportSelfMessage: true });
    const shaped = shapeEventForAdapter(baseEvent, opts);
    expect(shaped).not.toBeNull();
    expect(shaped!.message).toBe('hello');
    // raw_message is preserved untouched.
    expect(shaped!.raw_message).toBe('hello');
  });

  it('keeps message as array when format=array (default)', () => {
    const opts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: true });
    const shaped = shapeEventForAdapter(baseEvent, opts);
    expect(Array.isArray(shaped!.message)).toBe(true);
  });

  it('defaults partially-deserialized adapters to array format and no self report', () => {
    const opts = resolveReportOptions({});
    expect(opts.messageFormat).toBe('array');
    expect(opts.reportSelfMessage).toBe(false);
  });

  it('passes through non-message events unchanged', () => {
    const noticeEvent = {
      time: 1,
      self_id: SELF_ID,
      post_type: 'notice',
      notice_type: 'group_increase',
      group_id: 1,
      user_id: 2,
    };
    const opts = resolveReportOptions({ messageFormat: 'string', reportSelfMessage: false });
    expect(shapeEventForAdapter(noticeEvent, opts)).toBe(noticeEvent);
  });
});

describe('buildDispatchPayload + pickDispatchJson', () => {
  const messageEvent = {
    time: 1,
    self_id: SELF_ID,
    post_type: 'message',
    message_type: 'private',
    sub_type: 'friend',
    message_id: 7,
    user_id: PEER_UIN,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
    font: 0,
    sender: { user_id: PEER_UIN, nickname: 'peer', sex: 'unknown', age: 0 },
  };

  const selfMessageEvent = { ...messageEvent, post_type: 'message_sent', user_id: SELF_ID };

  const noticeEvent = {
    time: 1,
    self_id: SELF_ID,
    post_type: 'notice',
    notice_type: 'group_increase',
    group_id: 1,
    user_id: 2,
  };

  it('builds at most two distinct JSON variants for a message event', () => {
    const payload = buildDispatchPayload(messageEvent);
    expect(payload.isSelfMessage).toBe(false);

    const arr = JSON.parse(payload.arrayJson);
    const str = JSON.parse(payload.stringJson);
    expect(Array.isArray(arr.message)).toBe(true);
    expect(typeof str.message).toBe('string');
    expect(str.message).toBe('hello');
    expect(str.raw_message).toBe('hello');
    // every other field should be byte-identical
    const { message: _arrMsg, ...arrRest } = arr;
    const { message: _strMsg, ...strRest } = str;
    expect(arrRest).toEqual(strRest);
  });

  it('flags self messages and uses identical JSON for non-message events', () => {
    const selfPayload = buildDispatchPayload(selfMessageEvent);
    expect(selfPayload.isSelfMessage).toBe(true);

    const noticePayload = buildDispatchPayload(noticeEvent);
    expect(noticePayload.isSelfMessage).toBe(false);
    // Non-message events do not need a separate string variant.
    expect(noticePayload.arrayJson).toBe(noticePayload.stringJson);
  });

  it('routes connections to the right pre-serialized variant in O(1)', () => {
    const payload = buildDispatchPayload(messageEvent);
    const arrayOpt = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: false });
    const stringOpt = resolveReportOptions({ messageFormat: 'string', reportSelfMessage: false });

    expect(pickDispatchJson(payload, arrayOpt)).toBe(payload.arrayJson);
    expect(pickDispatchJson(payload, stringOpt)).toBe(payload.stringJson);
  });

  it('drops self-message dispatches for adapters that opt out', () => {
    const payload = buildDispatchPayload(selfMessageEvent);
    const offOpt = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: false });
    expect(pickDispatchJson(payload, offOpt)).toBeNull();

    const onOpt = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: true });
    const json = pickDispatchJson(payload, onOpt);
    expect(json).not.toBeNull();
    expect(JSON.parse(json!).post_type).toBe('message_sent');
  });

  it('serializes only twice regardless of fan-out size', () => {
    const payload = buildDispatchPayload(messageEvent);
    // Mixed fleet of adapters with different formats / self-report options.
    const adapters = Array.from({ length: 50 }, (_, i) => i % 2 === 0
      ? { messageFormat: 'array' as const, reportSelfMessage: false }
      : { messageFormat: 'string' as const, reportSelfMessage: true },
    );
    const seen = new Set(
      adapters
        .map((opts) => pickDispatchJson(payload, opts))
        .filter((j): j is string => j !== null),
    );
    // No matter the fan-out, only at most the two prebuilt strings appear.
    expect(seen.size).toBeLessThanOrEqual(2);
    expect(seen.has(payload.arrayJson)).toBe(true);
    expect(seen.has(payload.stringJson)).toBe(true);
  });
});
