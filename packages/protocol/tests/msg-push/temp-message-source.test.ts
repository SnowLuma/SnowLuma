import type { PacketInfo } from '@snowluma/common/protocol-types';
import {
  protobuf_encode,
  type pb,
  type pb_repeated,
  type string,
  type uint_32,
} from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

import type { IdentityService } from '../../src/identity-service';
import { parseMsgPush } from '../../src/msg-push';

interface TextFixture {
  str?: pb<1, string>;
}

interface ElemFixture {
  text?: pb<1, TextFixture>;
}

interface RichTextFixture {
  elems?: pb_repeated<2, ElemFixture>;
}

interface MessageBodyFixture {
  richText?: pb<1, RichTextFixture>;
}

interface TempSessionFixture {
  previousGroup?: pb<4, uint_32>;
  sourceGroup?: pb<5, uint_32>;
}

interface ResponseHeadFixture {
  fromUin?: pb<1, uint_32>;
  fromUid?: pb<2, string>;
  tempSession?: pb<7, TempSessionFixture>;
}

interface ContentHeadFixture {
  msgType?: pb<1, uint_32>;
  sequence?: pb<5, uint_32>;
  timestamp?: pb<6, uint_32>;
  ntMsgSeq?: pb<11, uint_32>;
}

interface PushBodyFixture {
  responseHead?: pb<1, ResponseHeadFixture>;
  contentHead?: pb<2, ContentHeadFixture>;
  body?: pb<3, MessageBodyFixture>;
}

interface PushFixture {
  message?: pb<1, PushBodyFixture>;
}

const identity = { findFriend: () => undefined } as unknown as IdentityService;

function tempMessagePacket(previousGroup: number, sourceGroup: number): PacketInfo {
  return {
    pid: 1,
    uin: '2000000001',
    serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
    seqId: 1,
    retCode: 0,
    fromClient: false,
    body: protobuf_encode<PushFixture>({
      message: {
        responseHead: {
          fromUin: 10001,
          fromUid: 'u_peer',
          tempSession: { previousGroup, sourceGroup },
        },
        contentHead: {
          msgType: 141,
          sequence: 7,
          timestamp: 1_710_000_000,
          ntMsgSeq: 8,
        },
        body: { richText: { elems: [{ text: { str: 'hello' } }] } },
      },
    }),
  };
}

describe('parseMsgPush — temporary-session source (#308)', () => {
  it('keeps a passive reply bound to the group that opened the current session', () => {
    const events = parseMsgPush(tempMessagePacket(11111, 22222), identity);

    expect(events).toMatchObject([{
      kind: 'temp_message',
      senderUin: 10001,
      groupId: 22222,
      elements: [{ type: 'text', text: 'hello' }],
    }]);
  });
});
