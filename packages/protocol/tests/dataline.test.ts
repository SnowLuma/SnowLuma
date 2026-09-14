import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { DatalineMsgBody, DatalineTextMsg } from '@snowluma/proto-defs/dataline';
import type { PushMsg, PushMsgBody } from '@snowluma/proto-defs/message';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';
import { encodeDatalineText } from '../src/dataline/codec';
import {
  DATALINE_UIN_PAD,
  DATALINE_UIN_PHONE,
} from '../src/dataline/device-contacts';
import type { IdentityService } from '../src/identity-service';
import { parseMsgPush } from '../src/msg-push';

const identity = { findFriend: () => undefined } as unknown as IdentityService;
const encoder = new TextEncoder();

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

function datalinePush(
  body: DatalineMsgBody,
  extras: Partial<PushMsgBody> = {},
): PacketInfo {
  return pushPacket({
    responseHead: { fromUin: 2000000001, fromUid: 'u_self' },
    contentHead: {
      msgType: 529,
      subType: 7,
      sequence: 11,
      ntMsgSeq: 22,
      timestamp: 1710000000,
      msgId: 33,
    },
    body: { msgContent: protobuf_encode<DatalineMsgBody>(body) },
    ...extras,
  });
}

function textBuf(text: string): Uint8Array {
  return protobuf_encode<DatalineTextMsg>({
    items: [{ type: 1, text: encoder.encode(text) }],
  });
}

describe('dataline my-device chats', () => {
  it('decodes an incoming Pad text push as a named device peer', () => {
    const out = parseMsgPush(datalinePush({
      subCmd: 4,
      header: {
        srcAppId: 1001,
        srcInstId: 1,
        dstAppId: 1,
        dstInstId: 1,
        dstUin: 2000000001n,
        srcUin: 2000000001n,
        srcTerType: 3,
        dstTerType: 1,
      },
      generic: {
        sessionId: 1n,
        size: 1,
        index: 0,
        type: 1,
        buf: textBuf('from pad'),
      },
    }), identity);

    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({
      kind: 'friend_message',
      senderUin: DATALINE_UIN_PAD,
      senderUid: 'u_l7jpPIZxQo0mzJwoEt-SKw',
      peerUin: DATALINE_UIN_PAD,
      senderNick: '我的Pad',
      elements: [{ type: 'text', text: 'from pad' }],
    });
  });

  it('treats a self-originated device text as a message_sent-style peer rewrite', () => {
    const out = parseMsgPush(datalinePush({
      subCmd: 4,
      header: {
        srcAppId: 1,
        srcInstId: 1,
        dstAppId: 1001,
        dstInstId: 1,
        dstUin: 2000000001n,
        srcUin: 2000000001n,
        srcTerType: 1,
        dstTerType: 2,
      },
      generic: {
        sessionId: 2n,
        size: 1,
        index: 0,
        type: 1,
        buf: textBuf('to phone'),
      },
    }), identity);

    expect(out[0]).toMatchObject({
      kind: 'friend_message',
      senderUin: 2000000001,
      senderUid: 'u_self',
      peerUin: DATALINE_UIN_PHONE,
      senderNick: '',
      elements: [{ type: 'text', text: 'to phone' }],
    });
  });

  it('surfaces a device file notify as a file element', () => {
    const out = parseMsgPush(datalinePush({
      subCmd: 1,
      header: {
        srcTerType: 2,
        dstTerType: 1,
        srcUin: 2000000001n,
        dstUin: 2000000001n,
      },
      ftn: [{
        sessionId: 9n,
        fileName: 'shot.png',
        fileIndex: 'ftn-1',
        fileLen: 32n,
      }],
    }), identity);

    expect(out[0]).toMatchObject({
      kind: 'friend_message',
      senderUin: DATALINE_UIN_PHONE,
      senderNick: '我的手机',
      elements: [{ type: 'file', fileId: 'ftn-1', fileName: 'shot.png', fileSize: 32 }],
    });
  });

  it('round-trips outbound device text through the same decoder', () => {
    const encoded = encodeDatalineText({
      selfUin: 2000000001,
      dstTerType: 2,
      text: 'hello phone',
    });
    const out = parseMsgPush(pushPacket({
      responseHead: { fromUin: 2000000001, fromUid: 'u_self' },
      contentHead: { msgType: 529, subType: 7, sequence: 1, timestamp: 1, msgId: 1 },
      body: { msgContent: encoded },
    }), identity);

    expect(out[0]).toMatchObject({
      kind: 'friend_message',
      senderUin: 2000000001,
      peerUin: DATALINE_UIN_PHONE,
      elements: [{ type: 'text', text: 'hello phone' }],
    });
  });
});
