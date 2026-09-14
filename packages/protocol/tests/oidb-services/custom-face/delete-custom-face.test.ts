import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { DeleteCustomFace } from '../../../src/oidb-services/custom-face/delete-custom-face';

function makeSender() {
  const resp: SendPacketResult = {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.alloc(0),
  };
  return { sendRawPacket: vi.fn(async () => resp) };
}

const SAMPLE_UIN = '2550419068';
const SAMPLE_EMOJI_ID = '2550419068_0_0_0_2765030D118F8E04B1BFB8DC773C343B_0_0';

// Wire bytes captured from QQ 9.9.26-44343 (Faceroam.OpReq, opType=2, deleting
// the emoji_id above).
const DELETE_WIRE_HEX =
  '0a0e0801120a31302e302e323632303010fc9c91c00918022a370a35323535303431393036385f305f305f305f32373635303330443131384638453034423142464238444337373343333433425f305f30';

describe('DeleteCustomFace namespace', () => {
  describe('serialize + encode', () => {
    it('reproduces the captured delete wire bytes exactly', () => {
      const req = DeleteCustomFace.serialize({} as any, { uin: SAMPLE_UIN, emojiId: SAMPLE_EMOJI_ID });
      const hex = Buffer.from(DeleteCustomFace.encode(req)).toString('hex');
      expect(hex).toBe(DELETE_WIRE_HEX);
    });

    it('omits qqVersion from inner (delete inner is 14 bytes, not 28)', () => {
      const req = DeleteCustomFace.serialize({} as any, { uin: SAMPLE_UIN, emojiId: 'x' });
      expect(req.inner?.qqVersion).toBeUndefined();
    });

    it('puts the emoji_id into field5.body.emojiId', () => {
      const req = DeleteCustomFace.serialize({} as any, { uin: SAMPLE_UIN, emojiId: SAMPLE_EMOJI_ID });
      expect(req.body?.emojiId).toBe(SAMPLE_EMOJI_ID);
    });

    it('uses field3=2 and leaves field6 unset', () => {
      const req = DeleteCustomFace.serialize({} as any, { uin: SAMPLE_UIN, emojiId: 'x' });
      expect(req.field3).toBe(2);
      expect(req.field6).toBeUndefined();
    });
  });

  describe('invoke', () => {
    it('routes through "Faceroam.OpReq"', async () => {
      const sender = makeSender();
      await DeleteCustomFace.invoke(sender, { uin: SAMPLE_UIN, emojiId: SAMPLE_EMOJI_ID });
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('Faceroam.OpReq');
    });

    it('passes the captured wire body', async () => {
      const sender = makeSender();
      await DeleteCustomFace.invoke(sender, { uin: SAMPLE_UIN, emojiId: SAMPLE_EMOJI_ID });
      const [, body] = sender.sendRawPacket.mock.calls[0]!;
      expect(Buffer.from(body as Uint8Array).toString('hex')).toBe(DELETE_WIRE_HEX);
    });

    it('resolves on success without returning a body', async () => {
      const sender = makeSender();
      await expect(DeleteCustomFace.invoke(sender, { uin: SAMPLE_UIN, emojiId: 'x' })).resolves.toBeUndefined();
    });

    it('throws when the sender reports no response', async () => {
      const sender = {
        sendRawPacket: vi.fn(async (): Promise<SendPacketResult> => ({
          success: false, gotResponse: false, errorCode: 0, errorMessage: 'timeout', responseData: null,
        })),
      };
      await expect(DeleteCustomFace.invoke(sender, { uin: SAMPLE_UIN, emojiId: 'x' })).rejects.toThrow();
    });
  });
});
