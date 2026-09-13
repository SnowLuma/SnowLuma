import { describe, expect, it, vi } from 'vitest';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import { SetSearch } from '../../src/oidb-services/group-admin/set-search';

// Capture the exact OIDB request bytes SetSearch sends, via a fake sender.
async function sentHex(params: SetSearch.Params): Promise<string> {
  let body: Uint8Array | undefined;
  const deps = {
    sendRawPacket: vi.fn(async (_cmd: string, b: Uint8Array): Promise<SendPacketResult> => {
      body = b;
      return { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
    }),
  };
  await SetSearch.invoke(deps as never, params);
  return Buffer.from(body!).toString('hex');
}

// settings (field2) sub-message: noFingerOpen = tag 35 (35<<3 = 280 → varint
// "98 02"), noCodeFingerOpen = tag 36 (36<<3 = 288 → "a0 02"). Tags RE'd
// empirically on a live group (#191, see Oidb0x89a_0SearchSettings).
describe('SetSearch (0x89a_0) settings encoding (#191)', () => {
  it('emits BOTH flags even at value 0 — toggle-off must not be dropped', async () => {
    const h = await sentHex({ groupId: 941657197, noFingerOpen: 0, noCodeFingerOpen: 0 });
    // field2 = { 35: 0, 36: 0 } → 12 06 980200 a00200
    expect(h).toContain('1206980200a00200');
  });

  it('emits value 1 correctly', async () => {
    const h = await sentHex({ groupId: 941657197, noFingerOpen: 1, noCodeFingerOpen: 1 });
    expect(h).toContain('1206980201a00201');
  });

  it('elides an unprovided flag (undefined → not sent)', async () => {
    const h = await sentHex({ groupId: 941657197, noCodeFingerOpen: 0 });
    expect(h).toContain('a00200');       // tag 36 (noCodeFingerOpen) present, value 0
    expect(h).not.toContain('980200');   // tag 35 (noFingerOpen) absent
  });

  it('carries the group uin + command 0x89a_0', async () => {
    const deps = {
      sendRawPacket: vi.fn(async (): Promise<SendPacketResult> => ({
        success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0),
      })),
    };
    await SetSearch.invoke(deps as never, { groupId: 941657197, noFingerOpen: 1 });
    expect(deps.sendRawPacket).toHaveBeenCalledWith('OidbSvcTrpcTcp.0x89a_0', expect.anything());
  });
});
