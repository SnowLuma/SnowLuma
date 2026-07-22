// Round-trips the SsoGetC2cMsg request/response protos (proton codegen + field
// tags) and the fetched private-history decode path (each returned PushMsgBody
// re-uses the regular friend decoder).

import { describe, expect, it } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  SsoGetC2cMsg,
  SsoGetC2cMsgResponse,
  SsoGetRoamMsg,
  SsoGetRoamMsgResponse,
} from '@snowluma/proto-defs/get-c2c-msg';
import type { IdentityService } from '../../src/identity-service';
import {
  SSO_GET_C2C_MSG_CMD,
  SSO_GET_ROAM_MSG_CMD,
  fetchC2cMessageRange,
  fetchC2cRoamMessagePage,
} from '../../src/msg-push';

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
          contentHead: { msgType: 166, sequence: 9120, ntMsgSeq: 120, timestamp: 1700000120, msgId: 7120 },
          body: { richText: { elems: [{ text: { str: 'hi' } }] } },
        },
        {
          responseHead: { fromUin: 111, forward: { friendName: 'Alice' } },
          contentHead: { msgType: 166, sequence: 9110, ntMsgSeq: 110, timestamp: 1700000110, msgId: 7110 },
          body: { richText: { elems: [{ text: { str: 'hi' } }] } },
        },
        {
          responseHead: { fromUin: 10001, toUin: 333, forward: { friendName: 'Self' } },
          contentHead: { msgType: 166, sequence: 9115, ntMsgSeq: 115, timestamp: 1700000115, msgId: 7115 },
          body: { richText: { elems: [{ text: { str: 'sent' } }] } },
        },
      ],
    });
    const sender = { sendRawPacket: async () => okResult(resp) };

    const out = await fetchC2cMessageRange(sender, identity, 10001, 'u_friend', 100, 120);

    expect(out.map((m) => m.ntMsgSeq)).toEqual([110, 115, 120]); // sorted by server sequence
    expect(out.every((m) => m.kind === 'friend_message')).toBe(true);
    expect(out.every((m) => m.selfUin === 10001)).toBe(true);
    expect(out[0]).toMatchObject({ msgSeq: 9110, ntMsgSeq: 110, clientSeq: 9110, senderUin: 111, senderNick: 'Alice' });
    expect(out[1]).toMatchObject({ msgSeq: 9115, ntMsgSeq: 115, clientSeq: 9115, senderUin: 10001, peerUin: 333, senderNick: 'Self' });
    expect(out[2]).toMatchObject({ msgSeq: 9120, ntMsgSeq: 120, clientSeq: 9120, senderUin: 222, senderNick: 'Bob' });
  });

  it('drops content-less blank messages, keeps real ones (#102 parity)', async () => {
    const resp = protobuf_encode<SsoGetC2cMsgResponse>({
      friendUid: 'u_friend',
      messages: [
        { // genuinely-blank control push (the invite phantom) → dropped
          responseHead: { fromUin: 111, forward: { friendName: 'Alice' } },
          contentHead: { msgType: 166, sequence: 9110, ntMsgSeq: 110, timestamp: 1700000110, msgId: 7110 },
          body: { richText: { elems: [] } },
        },
        { // real message → kept
          responseHead: { fromUin: 222, forward: { friendName: 'Bob' } },
          contentHead: { msgType: 166, sequence: 9120, ntMsgSeq: 120, timestamp: 1700000120, msgId: 7120 },
          body: { richText: { elems: [{ text: { str: 'hi' } }] } },
        },
      ],
    });
    const out = await fetchC2cMessageRange({ sendRawPacket: async () => okResult(resp) }, identity, 10001, 'u_friend', 100, 120);
    expect(out.map((m) => m.ntMsgSeq)).toEqual([120]);
    expect(out[0]).toMatchObject({ senderUin: 222, elements: [{ type: 'text', text: 'hi' }] });
  });

  it('rejects a visible message without the canonical NT sequence', async () => {
    const resp = protobuf_encode<SsoGetC2cMsgResponse>({
      friendUid: 'u_friend',
      messages: [{
        responseHead: { fromUin: 222, forward: { friendName: 'Bob' } },
        contentHead: { msgType: 166, sequence: 9120, timestamp: 1700000120, msgId: 7120 },
        body: { richText: { elems: [{ text: { str: 'hi' } }] } },
      }],
    });

    await expect(fetchC2cMessageRange(
      { sendRawPacket: async () => okResult(resp) },
      identity,
      10001,
      'u_friend',
      100,
      120,
    )).rejects.toThrow('canonical NT sequence');
  });

  it('surfaces a failed packet, while invalid input is rejected before sending', async () => {
    const failSender = { sendRawPacket: async () => ({ success: false, gotResponse: false } as SendPacketResult) };
    await expect(fetchC2cMessageRange(failSender, identity, 10001, 'u_x', 100, 120))
      .rejects.toThrow('SsoGetC2cMsg');

    let sent = false;
    const guardSender = { sendRawPacket: async () => { sent = true; return okResult(new Uint8Array()); } };
    expect(await fetchC2cMessageRange(guardSender, identity, 10001, '', 100, 120)).toEqual([]); // empty uid
    expect(await fetchC2cMessageRange(guardSender, identity, 10001, 'u_x', 200, 100)).toEqual([]); // start > end
    expect(sent).toBe(false);
  });
});

describe('fetchC2cRoamMessagePage / SsoGetRoamMsg', () => {
  it('encodes the timestamp cursor and orders both sides by canonical NT sequence', async () => {
    let captured: { cmd: string; body: Uint8Array } | null = null;
    const response = protobuf_encode<SsoGetRoamMsgResponse>({
      friendUid: 'u_friend',
      timestamp: 1700000000,
      random: 77,
      messages: [
        {
          responseHead: { fromUin: 10001, toUin: 222, forward: { friendName: 'Self' } },
          contentHead: { msgType: 166, sequence: 32743, ntMsgSeq: 63214, timestamp: 1700000001, msgId: 20 },
          body: { richText: { elems: [{ text: { str: 'out' } }] } },
        },
        {
          responseHead: { fromUin: 222, forward: { friendName: 'Bob' } },
          contentHead: { msgType: 166, sequence: 32742, ntMsgSeq: 63213, timestamp: 1700000002, msgId: 10 },
          body: { richText: { elems: [{ text: { str: 'in' } }] } },
        },
      ],
    });
    const sender = {
      sendRawPacket: async (cmd: string, body: Uint8Array) => {
        captured = { cmd, body };
        return okResult(response);
      },
    };

    const page = await fetchC2cRoamMessagePage(
      sender, identity, 10001, 'u_friend', 1700000100, 20, 9,
    );

    expect(captured!.cmd).toBe(SSO_GET_ROAM_MSG_CMD);
    const request = protobuf_decode<SsoGetRoamMsg>(captured!.body);
    expect(request).toMatchObject({
      friendUid: 'u_friend',
      time: 1700000100,
      random: 9,
      count: 20,
      direction: true,
    });
    expect(page.cursor).toEqual({ time: 1700000000, random: 77 });
    expect(page.messages.map((message) => ({
      sender: message.senderUin,
      sequence: message.ntMsgSeq,
      messageSequence: message.msgSeq,
      clientSequence: message.clientSeq,
    }))).toEqual([
      { sender: 222, sequence: 63213, messageSequence: 32742, clientSequence: 32742 },
      { sender: 10001, sequence: 63214, messageSequence: 32743, clientSequence: 32743 },
    ]);
  });
});
