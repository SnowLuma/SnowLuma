import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbLike } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { SendLike } from '../../../src/oidb-services/interaction/send-like';

function makeDeps(uid = 'target-uid-xyz') {
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: Buffer.alloc(0) };
  return {
    sendRawPacket: vi.fn(async () => r),
    resolveUserUid: vi.fn(async () => uid),
  };
}

describe('SendLike namespace', () => {
  it('declares 0x7E5_104', () => {
    expect(SendLike.command).toBe(0x7E5);
    expect(SendLike.subCommand).toBe(104);
  });

  describe('serialize', () => {
    it('resolves uid via ctx and emits {targetUid, sourceId=71, count}', async () => {
      const deps = makeDeps('UID-AAA');
      const body = await SendLike.serialize(deps, { userId: 10001, count: 3 });
      expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
      expect(body).toEqual({ targetUid: 'UID-AAA', sourceId: 71, count: 3 });
    });

    it('throws when ctx returns an empty uid', async () => {
      const deps = makeDeps('');
      await expect(SendLike.serialize(deps, { userId: 10001, count: 1 }))
        .rejects.toThrow(/failed to resolve uid/);
    });
  });

  describe('invoke (e2e)', () => {
    it('routes to OidbSvcTrpcTcp.0x7e5_104', async () => {
      const deps = makeDeps();
      await SendLike.invoke(deps, { userId: 10001, count: 3 });
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x7e5_104');
    });

    it('encodes targetUid (field 11) + sourceId=71 (field 12) + count (field 13)', async () => {
      const deps = makeDeps('UID-BBB');
      await SendLike.invoke(deps, { userId: 10001, count: 5 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<OidbLike>>(bytes);
      expect(env.command).toBe(0x7E5);
      expect(env.subCommand).toBe(104);
      expect(env.body).toMatchObject({ targetUid: 'UID-BBB', sourceId: 71, count: 5 });
      // Defensive: the obsolete uin-form field must not appear (server
      // rejects uin-form payloads with "被点赞 QQ 号非法").
      expect((env.body as any).targetUin).toBeUndefined();
    });
  });
});
