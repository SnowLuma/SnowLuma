// Tests for the Event0x2DC subType=16 (GroupMsgEmojiLike) end-to-end:
//   - decoder strips the 7-byte prefix and decodes GroupReactNotify
//   - field13==35 yields a GroupMsgEmojiLikeEvent
//   - field13!=35 surfaces under MsgPush.Unknown and emits nothing
//   - converter shape matches the gocqhttp / NapCat extension layout
//   - formatEvent prints something readable in the [Event] log

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { protoEncode } from '../src/protobuf/decode';
import { GroupReactNotifySchema } from '../src/bridge/proto/notify';
import { decodeEvent0x2DC } from '../src/bridge/msg-push/decoders/event-0x2dc';
import type { MsgPushContext } from '../src/bridge/msg-push/context';
import { IdentityService } from '../src/bridge/identity-service';
import type { GroupMsgEmojiLikeEvent, QQEventVariant } from '../src/bridge/events';
import { convertGroupMsgEmojiLike } from '../src/onebot/event-converter/to-notice';
import { GROUP_MESSAGE_EVENT, hashMessageIdInt32 } from '../src/onebot/message-id';
import { formatEvent } from '../src/utils/event-format';
import { subscribeLogs, type LogEntry } from '../src/utils/logger';

const SELF_UIN = '10001';
const GROUP_ID = 123456789;

function makeIdentity(): IdentityService {
  return IdentityService.memory(SELF_UIN);
}

/** Build the raw bytes QQ would push into ctx.content for subType=16:
 *  a 7-byte magic prefix followed by an encoded GroupReactNotify. */
function buildReactContent(notify: Record<string, unknown>): Uint8Array {
  const prefix = new Uint8Array([0, 0, 0, 0, 0, 0, 0]);
  const body = protoEncode(notify as never, GroupReactNotifySchema);
  const out = new Uint8Array(prefix.length + body.length);
  out.set(prefix, 0);
  out.set(body, prefix.length);
  return out;
}

function makeCtx(content: Uint8Array, identity = makeIdentity()): MsgPushContext {
  return {
    head: { msgType: 732, subType: 16, sequence: 0, timestamp: 1735000000, msgId: 0 },
    fromUin: 0,
    fromUid: '',
    selfUin: Number(SELF_UIN),
    content,
    body: undefined,
    responseHead: undefined,
    identity,
  };
}

describe('decodeEvent0x2DC subType=16 — GroupMsgEmojiLike', () => {
  it('decodes a field13=35 react add into a GroupMsgEmojiLikeEvent', () => {
    const content = buildReactContent({
      groupUin: BigInt(GROUP_ID),
      field13: 35,
      groupReactionData: {
        data: {
          data: {
            groupReactionTarget: { seq: 4242n },
            groupReactionDataContent: {
              code: '76',
              count: 1,
              operatorUid: 'u_operator_xxx',
              type: 1, // add
            },
          },
        },
      },
    });

    const [event] = decodeEvent0x2DC(makeCtx(content)) as GroupMsgEmojiLikeEvent[];
    expect(event).toBeDefined();
    expect(event.kind).toBe('group_msg_emoji_like');
    expect(event.groupId).toBe(GROUP_ID);
    expect(event.operatorUid).toBe('u_operator_xxx');
    expect(event.emojiId).toBe('76');
    expect(event.msgSeq).toBe(4242);
    expect(event.count).toBe(1);
    expect(event.isAdd).toBe(true);
  });

  it('decodes type=2 as react remove (isAdd=false)', () => {
    const content = buildReactContent({
      groupUin: BigInt(GROUP_ID),
      field13: 35,
      groupReactionData: {
        data: {
          data: {
            groupReactionTarget: { seq: 1n },
            groupReactionDataContent: {
              code: '⭐',
              count: 1,
              operatorUid: 'u_x',
              type: 2,
            },
          },
        },
      },
    });

    const [event] = decodeEvent0x2DC(makeCtx(content)) as GroupMsgEmojiLikeEvent[];
    expect(event.isAdd).toBe(false);
    expect(event.emojiId).toBe('⭐');
  });

  it('drops the packet and logs to MsgPush.Unknown when field13 is not 35', () => {
    const captured: LogEntry[] = [];
    const unsub = subscribeLogs((e) => captured.push(e));

    const content = buildReactContent({
      groupUin: BigInt(GROUP_ID),
      field13: 99, // not 35
      groupReactionData: {
        data: { data: { groupReactionDataContent: { code: 'x', operatorUid: 'u_y' } } },
      },
    });

    const result = decodeEvent0x2DC(makeCtx(content));
    unsub();

    expect(result).toHaveLength(0);
    const unknown = captured.find((e) =>
      e.scope === 'MsgPush.Unknown' && /field13=99/.test(e.message));
    expect(unknown).toBeDefined();
  });

  it('returns empty when content is shorter than the prefix length', () => {
    const tooShort = new Uint8Array([1, 2, 3]); // < 7 bytes
    expect(decodeEvent0x2DC(makeCtx(tooShort))).toEqual([]);
  });
});

describe('convertGroupMsgEmojiLike — OneBot notice shape', () => {
  const baseEvent: GroupMsgEmojiLikeEvent = {
    kind: 'group_msg_emoji_like',
    time: 1735000000,
    selfUin: 10001,
    groupId: 123456789,
    operatorUin: 99999,
    operatorUid: 'u_x',
    msgSeq: 4242,
    emojiId: '76',
    count: 1,
    isAdd: true,
  };

  // Real production wiring puts a hashMessageIdInt32-based resolver
  // on the ctx; mirror that so message_id is the same value the
  // bot would have minted for the original message.
  const ctx = {
    selfId: 10001,
    imageUrlResolver: null,
    mediaUrlResolver: null,
    messageIdResolver: (_isGroup: boolean, sessionId: number, sequence: number, eventName: string) =>
      hashMessageIdInt32(sequence, sessionId, eventName),
    mediaSegmentSink: null,
  } as never;

  it('produces a group_msg_emoji_like notice with sub_type=add and resolved message_id', () => {
    const out = convertGroupMsgEmojiLike(ctx, baseEvent);
    expect(out.post_type).toBe('notice');
    expect(out.notice_type).toBe('group_msg_emoji_like');
    expect(out.sub_type).toBe('add');
    expect(out.group_id).toBe(123456789);
    expect(out.user_id).toBe(99999);
    expect(out.operator_id).toBe(99999);
    expect(out.message_seq).toBe(4242);
    expect(out.message_id).toBe(hashMessageIdInt32(4242, 123456789, GROUP_MESSAGE_EVENT));
    expect(out.likes).toEqual([{ emoji_id: '76', count: 1 }]);
  });

  it('flips sub_type to remove when isAdd is false', () => {
    const out = convertGroupMsgEmojiLike(ctx, { ...baseEvent, isAdd: false });
    expect(out.sub_type).toBe('remove');
  });
});

describe('formatEvent — group_msg_emoji_like', () => {
  let savedLevel: string | undefined;
  beforeEach(() => { savedLevel = process.env.SNOWLUMA_LOG_LEVEL; });
  afterEach(() => {
    if (savedLevel === undefined) delete process.env.SNOWLUMA_LOG_LEVEL;
    else process.env.SNOWLUMA_LOG_LEVEL = savedLevel;
  });

  it('renders a one-line summary with group, operator and emoji id', () => {
    const identity = IdentityService.memory(SELF_UIN);
    identity.rememberGroups([{
      groupId: GROUP_ID, groupName: 'TestGroup', remark: '',
      memberCount: 1, memberMax: 500, members: new Map(),
    }]);
    identity.rememberGroupMembers(GROUP_ID, [{
      uin: 99999, uid: 'u_x', nickname: 'Alice', card: '',
      role: 'member', level: 0, title: '',
      joinTime: 0, lastSentTime: 0, shutUpTime: 0,
    }]);

    const event: QQEventVariant = {
      kind: 'group_msg_emoji_like',
      time: 0, selfUin: Number(SELF_UIN),
      groupId: GROUP_ID,
      operatorUin: 99999, operatorUid: 'u_x',
      msgSeq: 100, emojiId: '76', count: 1, isAdd: true,
    };

    const line = formatEvent(identity, event);
    expect(line).toBeDefined();
    expect(line).toContain('TestGroup');
    expect(line).toContain('Alice');
    expect(line).toContain('[76]');
    expect(line).toContain('msgSeq=100');
  });
});
