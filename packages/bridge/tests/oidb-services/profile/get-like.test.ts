import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x7edReq, Oidb0x7edResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetLike } from '../../../src/oidb-services/profile/get-like';

function makeDeps(opts: {
  cachedSelfUid?: string | null;
  resolveUserUid?: (uin: number) => Promise<string>;
  responseBody?: Oidb0x7edResp;
} = {}) {
  const responseData = opts.responseBody !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({ body: opts.responseBody }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: { uin: '10001', selfUid: opts.cachedSelfUid ?? null } as any,
    resolveUserUid: vi.fn(opts.resolveUserUid ?? (async (uin: number) => `uid-of-${uin}`)),
  };
}

describe('GetLike namespace', () => {
  it('declares 0x7ED_12', () => {
    expect(GetLike.command).toBe(0x7ED);
    expect(GetLike.subCommand).toBe(12);
  });

  describe('invoke (target uid resolution)', () => {
    it('uses cached self uid when userId is omitted', async () => {
      const deps = makeDeps({
        cachedSelfUid: 'cached-self',
        responseBody: { userLikeInfos: [{ uid: 'cached-self', time: 0n, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, {});
      expect(deps.resolveUserUid).not.toHaveBeenCalled();
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x7edReq>>(bytes);
      expect(env.body?.targetUid).toBe('cached-self');
    });

    it('falls back to resolveUserUid for self when cache is empty', async () => {
      const deps = makeDeps({
        cachedSelfUid: null,
        resolveUserUid: vi.fn(async () => 'fresh-self') as any,
        responseBody: { userLikeInfos: [{ uid: 'fresh-self', time: 0n, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, {});
      expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
    });

    it('resolves other users via resolveUserUid', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'uid-of-99999', time: 0n, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, { userId: 99999 });
      expect(deps.resolveUserUid).toHaveBeenCalledWith(99999);
    });

    it('throws when self uin is invalid and cache is empty', async () => {
      const deps = makeDeps({ cachedSelfUid: null });
      deps.identity.uin = 'invalid';
      await expect(GetLike.invoke(deps, {})).rejects.toThrow('self uid is unavailable');
    });
  });

  describe('serialize', () => {
    it('always sets basic=1, vote=1, favorite=1 (full breakdown query)', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'u', time: 0n, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, { userId: 1 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x7edReq>>(bytes);
      expect(env.body?.basic).toBe(1);
      expect(env.body?.vote).toBe(1);
      expect(env.body?.favorite).toBe(1);
    });

    it('threads start / limit through to the request', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'u', time: 0n, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, { userId: 1, start: 5, limit: 50 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x7edReq>>(bytes);
      expect(env.body?.start).toBe(5);
      expect(env.body?.limit).toBe(50);
    });

    it('defaults start=0 / limit=10', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'u', time: 0n, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, { userId: 1 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x7edReq>>(bytes);
      expect(env.body?.start ?? 0).toBe(0);
      expect(env.body?.limit).toBe(10);
    });
  });

  describe('deserialize', () => {
    it('shapes favorite + vote info with the expected key names', () => {
      const out = GetLike.deserialize({
        userLikeInfos: [{
          uid: 'u', time: 1700000000n,
          favoriteInfo: { totalCount: 5, lastTime: 1n, newCount: 1 },
          voteInfo: { totalCount: 7, newCount: 2, lastTime: 2n },
        }],
      });
      expect(out.uid).toBe('u');
      expect(out.time).toBe(1700000000);
      expect(out.favoriteInfo).toEqual({
        total_count: 5, last_time: 1, today_count: 1, userInfos: [],
      });
      expect(out.voteInfo).toEqual({
        total_count: 7, new_count: 2, new_nearby_count: 0, last_visit_time: 2, userInfos: [],
      });
    });

    it('throws when there are no userLikeInfos', () => {
      expect(() => GetLike.deserialize({})).toThrow('get profile like info empty');
      expect(() => GetLike.deserialize({ userLikeInfos: [] })).toThrow('get profile like info empty');
    });

    it('defaults all count fields to 0 when omitted', () => {
      const out = GetLike.deserialize({ userLikeInfos: [{ uid: 'u', time: 0n }] });
      expect(out.favoriteInfo.total_count).toBe(0);
      expect(out.voteInfo.total_count).toBe(0);
    });
  });
});
