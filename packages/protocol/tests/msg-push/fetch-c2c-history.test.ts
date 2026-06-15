// Round-trips the SsoGetC2cMsg request/response protos (proton codegen + field
// tags) and the fetched private-history decode path (each returned PushMsgBody
// re-uses the regular friend decoder).

import { describe, expect, it } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SsoGetC2cMsg, SsoGetC2cMsgResponse } from '@snowluma/proto-defs/get-c2c-msg';
import type { IdentityService } from '../../src/identity-service';
import { SSO_GET_C2C_MSG_CMD, fetchC2cMessageRange } from '../../src/msg-push';

const identity = { findFriend: () => undefined } as unknown as IdentityService;

function okResult(data: Uint8Array): SendPacketResult {
  return { success: true, gotResponse: true, responseData: data } as SendPacketResult;
}

describe('fetchC2cMessageRange / SsoGetC2cMsg', () => {
  it('sends the right command and request field tags', async () => {
    let captured: { cmd: string; body: Uint8Array } | null = null;
    const sender = {
      sendRawPacket: async (cmd: string, body: Uint8Array) => {
        captured = { cmd, body };
        return okResult(protobuf_encode<SsoGetC2cMsgResponse>({ friendUid: 'u_friend', messages: [] }));
      },
    };

    await fetchC2cMessageRange(sender, identity, 10001, 'u_friend', 100, 120);

    expect(captured!.cmd).toBe(SSO_GET_C2C_MSG_CMD);
    const req = protobuf_decode<SsoGetC2cMsg>(captured!.body);
    expect(req.friendUid).toBe('u_friend');
    expect(req.startSequence).toBe(100);
    expect(req.endSequence).toBe(120);
  });

  it('decodes returned friend messages (seq/sender/self uin), oldest→newest', async () => {
    const resp = protobuf_encode<SsoGetC2cMsgResponse>({
      friendUid: 'u_friend',
      messages: [
        {
          responseHead: { fromUin: 222, forward: { friendName: 'Bob' } },
          contentHead: { msgType: 166, sequence: 120, timestamp: 1700000120, msgId: 7120 },
          body: { richText: { elems: [{ text: { str: 'hi' } }] } },
        },
        {
          responseHead: { fromUin: 111, forward: { friendName: 'Alice' } },
          contentHead: { msgType: 166, sequence: 110, timestamp: 1700000110, msgId: 7110 },
          body: { richText: { elems: [{ text: { str: 'hi' } }] } },
        },
      ],
    });
    const sender = { sendRawPacket: async () => okResult(resp) };

    const out = await fetchC2cMessageRange(sender, identity, 10001, 'u_friend', 100, 120);

    expect(out.map((m) => m.msgSeq)).toEqual([110, 120]); // sorted ascending
    expect(out.every((m) => m.kind === 'friend_message')).toBe(true);
    expect(out.every((m) => m.selfUin === 10001)).toBe(true);
    expect(out[0]).toMatchObject({ msgSeq: 110, senderUin: 111, senderNick: 'Alice' });
    expect(out[1]).toMatchObject({ msgSeq: 120, senderUin: 222, senderNick: 'Bob' });
  });

  it('drops content-less blank messages, keeps real ones (#102 parity)', async () => {
    const resp = protobuf_encode<SsoGetC2cMsgResponse>({
      friendUid: 'u_friend',
      messages: [
        { // genuinely-blank control push (the invite phantom) → dropped
          responseHead: { fromUin: 111, forward: { friendName: 'Alice' } },
          contentHead: { msgType: 166, sequence: 110, timestamp: 1700000110, msgId: 7110 },
          body: { richText: { elems: [] } },
        },
        { // real message → kept
          responseHead: { fromUin: 222, forward: { friendName: 'Bob' } },
          contentHead: { msgType: 166, sequence: 120, timestamp: 1700000120, msgId: 7120 },
          body: { richText: { elems: [{ text: { str: 'hi' } }] } },
        },
      ],
    });
    const out = await fetchC2cMessageRange({ sendRawPacket: async () => okResult(resp) }, identity, 10001, 'u_friend', 100, 120);
    expect(out.map((m) => m.msgSeq)).toEqual([120]);
    expect(out[0]).toMatchObject({ senderUin: 222, elements: [{ type: 'text', text: 'hi' }] });
  });

  it('returns [] on a failed packet, empty uid, or out-of-range request', async () => {
    const failSender = { sendRawPacket: async () => ({ success: false, gotResponse: false } as SendPacketResult) };
    expect(await fetchC2cMessageRange(failSender, identity, 10001, 'u_x', 100, 120)).toEqual([]);

    let sent = false;
    const guardSender = { sendRawPacket: async () => { sent = true; return okResult(new Uint8Array()); } };
    expect(await fetchC2cMessageRange(guardSender, identity, 10001, '', 100, 120)).toEqual([]); // empty uid
    expect(await fetchC2cMessageRange(guardSender, identity, 10001, 'u_x', 200, 100)).toEqual([]); // start > end
    expect(sent).toBe(false);
  });
});
