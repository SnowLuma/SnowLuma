import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x112eReq, Oidb0x112eResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { ClickInlineKeyboardButton } from '../../../src/oidb-services/misc/click-inline-keyboard-button';

function makeSender(resp?: Buffer) {
  const r: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: resp ?? Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('ClickInlineKeyboardButton namespace', () => {
  it('declares 0x112E_1', () => {
    expect(ClickInlineKeyboardButton.command).toBe(0x112E);
    expect(ClickInlineKeyboardButton.subCommand).toBe(1);
  });

  describe('serialize', () => {
    it('widens numeric ids to BigInt for uint_64 fields', () => {
      const out = ClickInlineKeyboardButton.serialize({
        groupId: 12345, botAppid: 67890, buttonId: 'btn', callbackData: 'data', msgSeq: 100,
      });
      expect(out.groupId).toBe(12345n);
      expect(out.botAppid).toBe(67890n);
      expect(out.msgSeq).toBe(100n);
    });

    it('always sends unknown7=0 / unknown9=1 magic values', () => {
      const out = ClickInlineKeyboardButton.serialize({
        groupId: 1, botAppid: 1, buttonId: 'x', callbackData: 'y', msgSeq: 1,
      });
      expect(out.unknown7).toBe(0);
      expect(out.unknown9).toBe(1);
    });

    it('coerces buttonId / callbackData to strings (defensive)', () => {
      const out = ClickInlineKeyboardButton.serialize({
        groupId: 1, botAppid: 1, buttonId: 123 as any, callbackData: null as any, msgSeq: 1,
      });
      expect(out.buttonId).toBe('123');
      expect(out.callbackData).toBe('');
    });
  });

  describe('deserialize', () => {
    it('shapes the response with status/promptType/promptIcon = 0', () => {
      expect(ClickInlineKeyboardButton.deserialize({
        result: 1, errMsg: 'ok', promptText: 'hi',
      } as Oidb0x112eResp)).toEqual({
        result: 1, errMsg: 'ok', status: 0, promptText: 'hi', promptType: 0, promptIcon: 0,
      });
    });

    it('defaults result/errMsg/promptText when omitted', () => {
      expect(ClickInlineKeyboardButton.deserialize({} as Oidb0x112eResp)).toEqual({
        result: 0, errMsg: '', status: 0, promptText: '', promptType: 0, promptIcon: 0,
      });
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x112e_1', async () => {
      const sender = makeSender();
      await ClickInlineKeyboardButton.invoke(sender, {
        groupId: 1, botAppid: 1, buttonId: 'x', callbackData: 'y', msgSeq: 1,
      });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x112e_1');
    });

    it('round-trips a real envelope', async () => {
      const sender = makeSender(Buffer.from(protobuf_encode<OidbBase<Oidb0x112eResp>>({
        body: { result: 7, errMsg: 'denied', promptText: 'try again' } as any,
      })));
      const out = await ClickInlineKeyboardButton.invoke(sender, {
        groupId: 1, botAppid: 1, buttonId: 'x', callbackData: 'y', msgSeq: 1,
      });
      expect(out).toMatchObject({ result: 7, errMsg: 'denied', promptText: 'try again' });
    });

    it('encodes envelope body with all fields', async () => {
      const sender = makeSender();
      await ClickInlineKeyboardButton.invoke(sender, {
        groupId: 12345, botAppid: 67890, buttonId: 'b', callbackData: 'c', msgSeq: 999,
      });
      const [, bytes] = sender.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x112eReq>>(bytes);
      expect(env.body).toMatchObject({
        botAppid: 67890n, msgSeq: 999n, buttonId: 'b', callbackData: 'c',
        groupId: 12345n, unknown9: 1,
      });
    });
  });
});
