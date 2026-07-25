import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { GeneralGrayTipInfo } from '@snowluma/proto-defs/notify';
import { protobuf_encode } from '@snowluma/proton';
import { describe, expect, it } from 'vitest';

import type { IdentityService } from '../../src/identity-service';
import { parseMsgPush } from '../../src/msg-push';

const SELF_UIN = 10001;
const FRIEND_A = 20001;
const FRIEND_B = 20002;

const identity = {
  findUinByUid: () => null,
} as unknown as IdentityService;

function friendPokePacket(
  peerUin: number,
  senderUin: number,
  targetUin: number,
): PacketInfo {
  const sentBySelf = senderUin === SELF_UIN;
  const grayTip = protobuf_encode<GeneralGrayTipInfo>({
    busiType: 12n,
    msgTemplParam: [
      { name: 'uin_str1', value: String(senderUin) },
      { name: 'uin_str2', value: String(targetUin) },
      { name: 'action_str', value: '拍了拍' },
      { name: 'suffix_str', value: '一下' },
    ],
  });
  const body = protobuf_encode<PushMsg>({
    message: {
      responseHead: sentBySelf
        ? { fromUin: SELF_UIN, toUin: peerUin }
        : { fromUin: peerUin, toUin: SELF_UIN },
      contentHead: {
        msgType: 528,
        subType: 290,
        timestamp: 1710000000,
      },
      body: { msgContent: grayTip },
    },
  });
  return {
    pid: 1,
    uin: String(SELF_UIN),
    serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
    seqId: 1,
    retCode: 0,
    fromClient: false,
    body,
  };
}

describe('parseMsgPush — private poke conversation identity (#285)', () => {
  it('preserves the private peer independently of the poke sender and target', () => {
    const events = [
      ...parseMsgPush(friendPokePacket(FRIEND_A, SELF_UIN, SELF_UIN), identity),
      ...parseMsgPush(friendPokePacket(FRIEND_B, SELF_UIN, SELF_UIN), identity),
      ...parseMsgPush(friendPokePacket(FRIEND_B, FRIEND_B, SELF_UIN), identity),
    ];

    expect(events.map((event) => {
      const poke = event as unknown as Record<string, unknown>;
      return {
        kind: poke.kind,
        peerUin: poke.peerUin,
        senderUin: poke.senderUin,
        targetUin: poke.targetUin,
      };
    })).toEqual([
      { kind: 'friend_poke', peerUin: FRIEND_A, senderUin: SELF_UIN, targetUin: SELF_UIN },
      { kind: 'friend_poke', peerUin: FRIEND_B, senderUin: SELF_UIN, targetUin: SELF_UIN },
      { kind: 'friend_poke', peerUin: FRIEND_B, senderUin: FRIEND_B, targetUin: SELF_UIN },
    ]);
  });
});
