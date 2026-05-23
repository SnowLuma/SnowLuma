import { describe, expect, it, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbClientKeyResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { ForceFetchClientKey } from '../../../src/oidb-services/web/force-fetch-client-key';

function makeSender(body?: OidbClientKeyResp) {
  const responseData = body !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<OidbClientKeyResp>>({ body }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return { sendRawPacket: vi.fn(async () => r) };
}

describe('ForceFetchClientKey namespace', () => {
  it('declares 0x102A_1', () => {
    expect(ForceFetchClientKey.command).toBe(0x102A);
    expect(ForceFetchClientKey.subCommand).toBe(1);
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x102a_1', async () => {
      const sender = makeSender({ clientKey: 'ck', keyIndex: 19, expireTime: 1800 });
      await ForceFetchClientKey.invoke(sender);
      expect(sender.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x102a_1');
    });

    it('returns the parsed clientKey / keyIndex / expireTime', async () => {
      const sender = makeSender({ clientKey: 'KEY', keyIndex: 7, expireTime: 600 });
      const out = await ForceFetchClientKey.invoke(sender);
      expect(out).toEqual({ clientKey: 'KEY', keyIndex: '7', expireTime: '600' });
    });

    it('falls back to keyIndex="19" and expireTime="1800" when server omits them', async () => {
      const sender = makeSender({ clientKey: 'KEY' });
      const out = await ForceFetchClientKey.invoke(sender);
      expect(out.keyIndex).toBe('19');
      expect(out.expireTime).toBe('1800');
    });

    it('returns empty clientKey when server omits it', async () => {
      const sender = makeSender({});
      const out = await ForceFetchClientKey.invoke(sender);
      expect(out.clientKey).toBe('');
    });
  });
});
