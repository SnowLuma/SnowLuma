import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { FaceroamOpReq, FaceroamOpResp } from '@snowluma/proto-defs/oidb-actions/base';

import { FetchCustomFaceList } from '../../../src/oidb-services/custom-face/fetch-custom-face-list';

const SAMPLE_UIN = '10001';
const EMOJI_A = '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
const EMOJI_B = '10001_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';

function encodeLegacyList(uin: string): Uint8Array {
  return protobuf_encode<FaceroamOpReq>({
    inner: { field1: 1, osVersion: '10.0.26200', qqVersion: '9.9.28-46928' },
    uin: BigInt(uin),
    field3: 1,
    field6: 1,
  });
}

function makeSender(opts: {
  faces?: FaceroamOpResp;
  success?: boolean;
  gotResponse?: boolean;
  errorMessage?: string;
  responseData?: Uint8Array | null;
} = {}) {
  const result: SendPacketResult = {
    success: opts.success ?? true,
    gotResponse: opts.gotResponse ?? true,
    errorCode: 0,
    errorMessage: opts.errorMessage ?? '',
    responseData: opts.responseData !== undefined
      ? opts.responseData
      : Buffer.from(protobuf_encode<FaceroamOpResp>(
        opts.faces ?? { retCode: 0, item: { faceIds: [EMOJI_A, EMOJI_B] } },
      )),
  };
  return { sendRawPacket: vi.fn(async () => result) };
}

describe('FetchCustomFaceList namespace', () => {
  describe('serialize + encode', () => {
    it('keeps the list request bytes the ProfileApi fetch already sent', () => {
      const req = FetchCustomFaceList.serialize({} as any, { uin: SAMPLE_UIN });
      const hex = Buffer.from(FetchCustomFaceList.encode(req)).toString('hex');
      expect(hex).toBe(Buffer.from(encodeLegacyList(SAMPLE_UIN)).toString('hex'));
    });

    it('sends qqVersion on inner and sets field3=1 / field6=1', () => {
      const req = FetchCustomFaceList.serialize({} as any, { uin: SAMPLE_UIN });
      expect(req.inner?.qqVersion).toBe('9.9.28-46928');
      expect(req.inner?.osVersion).toBe('10.0.26200');
      expect(req.field3).toBe(1);
      expect(req.field6).toBe(1);
      expect(req.body).toBeUndefined();
    });
  });

  describe('invoke', () => {
    it('routes through "Faceroam.OpReq" and returns the id list', async () => {
      const sender = makeSender();
      await expect(FetchCustomFaceList.invoke(sender, { uin: SAMPLE_UIN })).resolves.toEqual([
        EMOJI_A,
        EMOJI_B,
      ]);
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('Faceroam.OpReq');
      const [, body] = sender.sendRawPacket.mock.calls[0]!;
      expect(Buffer.from(body as Uint8Array).toString('hex')).toBe(
        Buffer.from(encodeLegacyList(SAMPLE_UIN)).toString('hex'),
      );
    });

    it('returns an empty list when the item is missing', async () => {
      const sender = makeSender({ faces: { retCode: 0 } });
      await expect(FetchCustomFaceList.invoke(sender, { uin: SAMPLE_UIN })).resolves.toEqual([]);
    });

    it('throws when the sender reports no response', async () => {
      const sender = makeSender({
        success: false,
        gotResponse: false,
        errorMessage: 'timeout',
        responseData: null,
      });
      await expect(FetchCustomFaceList.invoke(sender, { uin: SAMPLE_UIN })).rejects.toThrow(/timeout/);
    });

    it('throws when the Faceroam retCode is non-zero', async () => {
      const sender = makeSender({ faces: { retCode: 1, message: 'denied' } });
      await expect(FetchCustomFaceList.invoke(sender, { uin: SAMPLE_UIN })).rejects.toThrow(
        /fetch custom face error: denied/,
      );
    });
  });
});
