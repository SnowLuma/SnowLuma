// Regression for #102: a group invite makes QQ emit a content-less c2c push
// (msgType=166/0, body.richText.elems=[]) right after the invite card. That
// phantom used to surface to OneBot clients as a confusing "[空消息]".
// parseMsgPush must drop a message that decodes to zero elements *when its body
// is genuinely empty*, while still keeping (and warning about) a message that
// carried content we merely failed to decode.

import { describe, expect, it } from 'vitest';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { protobuf_encode } from '@snowluma/proton';
import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import type { IdentityService } from '../../src/identity-service';
import { parseMsgPush } from '../../src/msg-push';

const identity = { findFriend: () => undefined } as unknown as IdentityService;

function pushPacket(message: PushMsgBody): PacketInfo {
  return {
    pid: 0,
    uin: '2000000001',
    serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
    seqId: 0,
    retCode: 0,
    fromClient: false,
    body: protobuf_encode<PushMsg>({ message }),
  };
}

describe('parseMsgPush — empty message drop (#102)', () => {
  it('drops a genuinely empty friend message (group-invite phantom)', () => {
    const out = parseMsgPush(pushPacket({
      responseHead: { fromUin: 10001, fromUid: 'u_x' },
      contentHead: { msgType: 166, subType: 0, sequence: 59962, timestamp: 1781540572, msgId: 1963990184 },
      body: { richText: { elems: [] } },
    }), identity);
    expect(out).toEqual([]);
  });

  it('keeps a friend message that actually has content', () => {
    const out = parseMsgPush(pushPacket({
      responseHead: { fromUin: 10001, fromUid: 'u_x' },
      contentHead: { msgType: 166, subType: 0, sequence: 100, timestamp: 1781540572, msgId: 1 },
      body: { richText: { elems: [{ text: { str: 'hi' } }] } },
    }), identity);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'friend_message', elements: [{ type: 'text', text: 'hi' }] });
  });

  it('drops a C2C control push by (msgType, c2cCmd) even when it carries content', () => {
    // 166 + c2c_cmd ∈ {1,73,75,129,131,133,135,192} is a control/system signal
    // QQ NT routes via OnRecvSysMsg, never a bubble — drop regardless of body.
    const out = parseMsgPush(pushPacket({
      responseHead: { fromUin: 10001, fromUid: 'u_x' },
      contentHead: { msgType: 166, subType: 0, c2cCmd: 75, sequence: 200, timestamp: 1781540572, msgId: 3 },
      body: { richText: { elems: [{ text: { str: 'noise' } }] } },
    }), identity);
    expect(out).toEqual([]);
  });

  it('keeps a normal 166 message whose c2cCmd is not a control command', () => {
    const out = parseMsgPush(pushPacket({
      responseHead: { fromUin: 10001, fromUid: 'u_x' },
      contentHead: { msgType: 166, subType: 0, c2cCmd: 0, sequence: 201, timestamp: 1781540572, msgId: 4 },
      body: { richText: { elems: [{ text: { str: 'hi' } }] } },
    }), identity);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'friend_message', elements: [{ type: 'text', text: 'hi' }] });
  });

  it('keeps an empty-decoded message whose body still carried content (missing decoder)', () => {
    // A commonElem service type the rich-body decoder ignores → 0 elements, but
    // the body was not empty, so the message must survive (and be warned about),
    // not be silently dropped.
    const out = parseMsgPush(pushPacket({
      responseHead: { fromUin: 10001, fromUid: 'u_x' },
      contentHead: { msgType: 166, subType: 0, sequence: 101, timestamp: 1781540572, msgId: 2 },
      body: { richText: { elems: [{ commonElem: { serviceType: 999, businessType: 0 } }] } },
    }), identity);
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ kind: 'friend_message', elements: [] });
  });
});
