// Round-trips the SsoGetGroupMsg request/response protos (proton codegen +
// field tags) and the fetched-history decode path (each returned PushMsgBody
// re-uses the regular group decoder).

import { describe, expect, it } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SsoGetGroupMsg, SsoGetGroupMsgResponse } from '@snowluma/proto-defs/get-group-msg';
import type { IdentityService } from '../../src/identity-service';
import { SSO_GET_GROUP_MSG_CMD, fetchGroupMessageRange } from '../../src/msg-push';

const identity = { findGroupMember: () => undefined } as unknown as IdentityService;

function okResult(data: Uint8Array): SendPacketResult {
  return { success: true, gotResponse: true, responseData: data } as SendPacketResult;
}

describe('fetchGroupMessageRange / SsoGetGroupMsg', () => {
  it('sends the right command and request field tags', async () => {
    let captured: { cmd: string; body: Uint8Array } | null = null;
    const sender = {
      sendRawPacket: async (cmd: string, body: Uint8Array) => {
        captured = { cmd, body };
        return okResult(protobuf_encode<SsoGetGroupMsgResponse>({ body: { groupUin: 9999, messages: [] } }));
      },
    };

    await fetchGroupMessageRange(sender, identity, 10001, 9999, 100, 120);

    expect(captured!.cmd).toBe(SSO_GET_GROUP_MSG_CMD);
    const req = protobuf_decode<SsoGetGroupMsg>(captured!.body);
    expect(req.info?.groupUin).toBe(9999);
    expect(req.info?.startSequence).toBe(100);
    expect(req.info?.endSequence).toBe(120);
    expect(req.direction).toBe(true);
  });

  it('decodes returned group messages (seq/group/sender, self uin), oldest→newest', async () => {
    const resp = protobuf_encode<SsoGetGroupMsgResponse>({
      body: {
        groupUin: 9999,
        startSequence: 100,
        endSequence: 120,
        messages: [
          {
            responseHead: { fromUin: 222, grp: { groupUin: 9999, memberName: 'Bob' } },
            contentHead: { msgType: 82, sequence: 120, timestamp: 1700000120, msgId: 5120 },
            body: { richText: { elems: [{ text: { str: 'hi' } }] } },
          },
          {
            responseHead: { fromUin: 111, grp: { groupUin: 9999, memberName: 'Alice' } },
            contentHead: { msgType: 82, sequence: 110, timestamp: 1700000110, msgId: 5110 },
            body: { richText: { elems: [{ text: { str: 'hi' } }] } },
          },
        ],
      },
    });
    const sender = { sendRawPacket: async () => okResult(resp) };

    const out = await fetchGroupMessageRange(sender, identity, 10001, 9999, 100, 120);

    expect(out.map((m) => m.msgSeq)).toEqual([110, 120]); // sorted ascending
    expect(out.every((m) => m.kind === 'group_message')).toBe(true);
    expect(out.every((m) => m.groupId === 9999)).toBe(true);
    expect(out.every((m) => m.selfUin === 10001)).toBe(true);
    expect(out[0]).toMatchObject({ msgSeq: 110, senderUin: 111, senderNick: 'Alice' });
    expect(out[1]).toMatchObject({ msgSeq: 120, senderUin: 222, senderNick: 'Bob' });
  });

  it('drops content-less blank messages, keeps real ones (#102 parity)', async () => {
    const resp = protobuf_encode<SsoGetGroupMsgResponse>({
      body: {
        groupUin: 9999,
        messages: [
          { // genuinely-blank control push → dropped
            responseHead: { fromUin: 111, grp: { groupUin: 9999, memberName: 'Alice' } },
            contentHead: { msgType: 82, sequence: 110, timestamp: 1700000110, msgId: 5110 },
            body: { richText: { elems: [] } },
          },
          { // real message → kept
            responseHead: { fromUin: 222, grp: { groupUin: 9999, memberName: 'Bob' } },
            contentHead: { msgType: 82, sequence: 120, timestamp: 1700000120, msgId: 5120 },
            body: { richText: { elems: [{ text: { str: 'hi' } }] } },
          },
        ],
      },
    });
    const out = await fetchGroupMessageRange({ sendRawPacket: async () => okResult(resp) }, identity, 10001, 9999, 100, 120);
    expect(out.map((m) => m.msgSeq)).toEqual([120]);
    expect(out[0]).toMatchObject({ senderUin: 222, elements: [{ type: 'text', text: 'hi' }] });
  });

  it('returns [] on a failed packet or out-of-range request', async () => {
    const failSender = { sendRawPacket: async () => ({ success: false, gotResponse: false } as SendPacketResult) };
    expect(await fetchGroupMessageRange(failSender, identity, 10001, 9999, 100, 120)).toEqual([]);

    // start > end is rejected before any send
    let sent = false;
    const guardSender = { sendRawPacket: async () => { sent = true; return okResult(new Uint8Array()); } };
    expect(await fetchGroupMessageRange(guardSender, identity, 10001, 9999, 200, 100)).toEqual([]);
    expect(sent).toBe(false);
  });
});
