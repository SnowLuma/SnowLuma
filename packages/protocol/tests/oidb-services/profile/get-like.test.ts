import { describe, expect, it, vi } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x7edReq, Oidb0x7edResp } from '@snowluma/proto-defs/oidb-actions/base';
import type { SendPacketResult } from '@snowluma/common/packet-sender';

import { GetLike } from '../../../src/oidb-services/profile/get-like';

function makeDeps(opts: {
  cachedSelfUid?: string | null;
  resolveUserUid?: (uin: number) => Promise<string>;
  findUinByUid?: (uid: string) => number | null;
  resolveUin?: (uid: string) => Promise<number | null>;
  responseBody?: Oidb0x7edResp;
} = {}) {
  const responseData = opts.responseBody !== undefined
    ? Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({ body: opts.responseBody }))
    : Buffer.alloc(0);
  const r: SendPacketResult = { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
  return {
    sendRawPacket: vi.fn(async () => r),
    identity: {
      uin: '10001',
      selfUid: opts.cachedSelfUid ?? null,
      findUinByUid: vi.fn(opts.findUinByUid ?? (() => null)),
      resolveUin: vi.fn(opts.resolveUin ?? (async () => null)),
    } as any,
    resolveUserUid: vi.fn(opts.resolveUserUid ?? (async (uin: number) => `uid-of-${uin}`)),
  };
}

describe('GetLike namespace', () => {
  it('uses the self and other-user subcommands selected by the native client', () => {
    const deps = makeDeps({ cachedSelfUid: 'self-uid' });
    expect(GetLike.command).toBe(0x7ED);
    expect(GetLike.resolveSubCommand({}, deps)).toBe(13);
    expect(GetLike.resolveSubCommand({ userId: 0 }, deps)).toBe(13);
    expect(GetLike.resolveSubCommand({ userId: 10001 }, deps)).toBe(13);
    expect(GetLike.resolveSubCommand({ userId: 20002 }, deps)).toBe(12);
  });

  describe('invoke (target uid resolution)', () => {
    it('uses cached self uid when userId is omitted', async () => {
      const deps = makeDeps({
        cachedSelfUid: 'cached-self',
        responseBody: { userLikeInfos: [{ uid: 'cached-self', time: 0, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, {});
      expect(deps.resolveUserUid).not.toHaveBeenCalled();
      const [serviceCmd, bytes] = deps.sendRawPacket.mock.calls[0]!;
      expect(serviceCmd).toBe('OidbSvcTrpcTcp.0x7ed_13');
      const env = protobuf_decode<OidbBase<Oidb0x7edReq>>(bytes);
      expect(env.body?.targetUids).toEqual(['cached-self']);
    });

    it('falls back to resolveUserUid for self when cache is empty', async () => {
      const deps = makeDeps({
        cachedSelfUid: null,
        resolveUserUid: vi.fn(async () => 'fresh-self') as any,
        responseBody: { userLikeInfos: [{ uid: 'fresh-self', time: 0, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, {});
      expect(deps.resolveUserUid).toHaveBeenCalledWith(10001);
    });

    it('resolves other users via resolveUserUid', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'uid-of-99999', time: 0, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, { userId: 99999 });
      expect(deps.resolveUserUid).toHaveBeenCalledWith(99999);
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x7ed_12');
    });

    it('treats an explicit self uin as a self query', async () => {
      const deps = makeDeps({
        cachedSelfUid: 'cached-self',
        responseBody: { userLikeInfos: [{ uid: 'cached-self', time: 0 }] },
      });
      await GetLike.invoke(deps, { userId: 10001 });
      expect(deps.resolveUserUid).not.toHaveBeenCalled();
      expect(deps.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x7ed_13');
    });

    it('throws when self uin is invalid and cache is empty', async () => {
      const deps = makeDeps({ cachedSelfUid: null });
      deps.identity.uin = 'invalid';
      await expect(GetLike.invoke(deps, {})).rejects.toThrow('self uid is unavailable');
    });
  });

  describe('serialize', () => {
    it('requests the profile-backed vote list', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'u', time: 0, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, { userId: 1 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x7edReq>>(bytes);
      expect(env.body?.basic).toBe(1);
      expect(env.body?.vote).toBe(1);
      expect(env.body?.favorite ?? 0).toBe(0);
      expect(env.body?.userProfile).toBe(1);
    });

    it('threads start / limit through to the request', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'u', time: 0, favoriteInfo: {}, voteInfo: {} }] },
      });
      await GetLike.invoke(deps, { userId: 1, start: 5, limit: 50 });
      const [, bytes] = deps.sendRawPacket.mock.calls[0]!;
      const env = protobuf_decode<OidbBase<Oidb0x7edReq>>(bytes);
      expect(env.body?.start).toBe(5);
      expect(env.body?.limit).toBe(50);
    });

    it('defaults start=0 / limit=10', async () => {
      const deps = makeDeps({
        responseBody: { userLikeInfos: [{ uid: 'u', time: 0, favoriteInfo: {}, voteInfo: {} }] },
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
      const deps = makeDeps({
        findUinByUid: uid => uid === 'vote-user' ? 12345 : null,
      });
      const out = GetLike.deserialize(deps, {
        userLikeInfos: [{
          uid: 'u', time: 1700000000,
          favoriteInfo: {
            totalCount: 5,
            lastTime: 1,
            todayCount: 1,
            userInfos: [{ uid: 'favorite-user', nick: '收藏者', count: 3 }],
          },
          voteInfo: {
            totalCount: 7,
            newCount: 2,
            newNearbyCount: 1,
            lastVisitTime: 2,
            userInfos: [{
              uid: 'vote-user',
              src: 4,
              latestTime: 3,
              count: 2,
              giftCount: 1,
              customId: 5,
              lastCharged: 6,
              availableCount: 7,
              todayVotedCount: 8,
              nick: '点赞者',
              gender: 1,
              age: 20,
              isFriend: true,
              isVip: true,
              isSvip: false,
            }],
          },
        }],
      });
      expect(out.uid).toBe('u');
      expect(out.time).toBe(1700000000);
      expect(out.favoriteInfo).toEqual({
        total_count: 5,
        last_time: 1,
        today_count: 1,
        userInfos: [expect.objectContaining({ uid: 'favorite-user', nick: '收藏者', count: 3 })],
      });
      expect(out.voteInfo).toEqual({
        total_count: 7,
        new_count: 2,
        new_nearby_count: 1,
        last_visit_time: 2,
        userInfos: [expect.objectContaining({
          uid: 'vote-user',
          uin: 12345,
          src: 4,
          latestTime: 3,
          count: 2,
          giftCount: 1,
          customId: 5,
          lastCharged: 6,
          bAvailableCnt: 7,
          bTodayVotedCnt: 8,
          nick: '点赞者',
          gender: 1,
          age: 20,
          isFriend: true,
          isvip: true,
          isSvip: false,
        })],
      });
    });

    it('throws when there are no userLikeInfos', () => {
      expect(() => GetLike.deserialize({} as any, {})).toThrow('get profile like info empty');
      expect(() => GetLike.deserialize({} as any, { userLikeInfos: [] })).toThrow('get profile like info empty');
    });

    it('throws when a returned user item has no uid', () => {
      expect(() => GetLike.deserialize(makeDeps(), {
        userLikeInfos: [{ uid: 'u', voteInfo: { userInfos: [{ nick: 'broken' }] } }],
      })).toThrow('get profile like user uid missing');
    });

    it('defaults all count fields to 0 when omitted', () => {
      const out = GetLike.deserialize(makeDeps(), { userLikeInfos: [{ uid: 'u', time: 0 }] });
      expect(out.favoriteInfo.total_count).toBe(0);
      expect(out.voteInfo.total_count).toBe(0);
    });
  });

  describe('invoke (inbound UIN fill)', () => {
    it('fills leftover uin=0 rows through Identity.resolveUin once per uid', async () => {
      const deps = makeDeps({
        cachedSelfUid: 'self-uid',
        findUinByUid: () => null,
        resolveUin: async (uid) => uid === 'shared-uid' ? 30003 : null,
        responseBody: {
          userLikeInfos: [{
            uid: 'self-uid',
            favoriteInfo: { userInfos: [{ uid: 'shared-uid', nick: '收藏' }] },
            voteInfo: { userInfos: [{ uid: 'shared-uid', nick: '点赞' }, { uid: 'miss-uid' }] },
          }],
        },
      });

      const out = await GetLike.invoke(deps, {});

      expect(deps.identity.resolveUin).toHaveBeenCalledTimes(2);
      expect(deps.identity.resolveUin).toHaveBeenCalledWith('shared-uid');
      expect(deps.identity.resolveUin).toHaveBeenCalledWith('miss-uid');
      expect(out.favoriteInfo.userInfos[0]?.uin).toBe(30003);
      expect(out.voteInfo.userInfos[0]?.uin).toBe(30003);
      expect(out.voteInfo.userInfos[1]?.uin).toBe(0);
    });

    it('does not call resolveUin when deserialize already filled the cache hit', async () => {
      const deps = makeDeps({
        cachedSelfUid: 'self-uid',
        findUinByUid: (uid) => uid === 'cached-uid' ? 20002 : null,
        responseBody: {
          userLikeInfos: [{
            uid: 'self-uid',
            voteInfo: { userInfos: [{ uid: 'cached-uid', nick: '点赞者' }] },
          }],
        },
      });

      const out = await GetLike.invoke(deps, {});

      expect(deps.identity.resolveUin).not.toHaveBeenCalled();
      expect(out.voteInfo.userInfos[0]?.uin).toBe(20002);
    });
  });
});
