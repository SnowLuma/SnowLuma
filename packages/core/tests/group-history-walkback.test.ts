// MessageApi history pagination: bidirectional chunking, dedup, short-cap
// handling, floor termination, and chronological output. Range fetches are
// mocked so this exercises cursor logic rather than wire decoding.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/protocol/msg-push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snowluma/protocol/msg-push')>();
  return {
    ...actual,
    fetchGroupMessageRange: vi.fn(),
    fetchC2cMessageRange: vi.fn(),
    fetchC2cRoamMessagePage: vi.fn(),
  };
});

import {
  fetchC2cMessageRange,
  fetchC2cRoamMessagePage,
  fetchGroupMessageRange,
} from '@snowluma/protocol/msg-push';
import { MessageApi } from '../src/bridge/apis/message';

const mockFetch = vi.mocked(fetchGroupMessageRange);
const mockC2cFetch = vi.mocked(fetchC2cMessageRange);
const mockC2cRoamFetch = vi.mocked(fetchC2cRoamMessagePage);

function gm(seq: number): any {
  return {
    kind: 'group_message', groupName: '', time: 0, selfUin: 0, senderUin: 1, msgSeq: seq,
    msgId: seq, elements: [], groupId: 9999, senderNick: '', senderCard: '', senderRole: '',
  };
}

const ctx = { identity: {}, sendRawPacket: vi.fn() } as any;

describe('MessageApi history pagination', () => {
  // The walk-back loop enforces a real ~300ms gap between each SsoGetGroupMsg
  // send (a deliberate anti-flood throttle, unchanged in production). Fake the
  // clock so the test exercises the loop/cursor logic instantly instead of
  // waiting out 300ms × up-to-12 real sends.
  beforeEach(() => {
    mockFetch.mockReset();
    mockC2cFetch.mockReset();
    mockC2cRoamFetch.mockReset();
    vi.useFakeTimers();
  });
  afterEach(() => vi.useRealTimers());

  // Drives a throttled getGroupHistory to completion under fake timers: kick it
  // off, flush the queued send-gap timers, then await the result.
  async function runHistory<T>(promise: Promise<T>): Promise<T> {
    await vi.runAllTimersAsync();
    return promise;
  }

  it('walks back across short-capped windows, dedups, returns newest `want` ascending', async () => {
    // Server caps every window to its newest 10 sequences → forces walk-back.
    mockFetch.mockImplementation(async (_s, _id, _self, _g, start, end) => {
      const out = [];
      for (let s = Math.max(start, end - 9); s <= end; s++) out.push(gm(s));
      return out;
    });

    const res = await runHistory(new MessageApi(ctx).getGroupHistory(9999, 200, 50));

    expect(res).toHaveLength(50);
    expect(res[0].msgSeq).toBe(151); // newest 50 ending at 200 → 151..200
    expect(res[res.length - 1].msgSeq).toBe(200);
    for (let i = 1; i < res.length; i++) {
      expect(res[i].msgSeq).toBeGreaterThan(res[i - 1].msgSeq); // strictly ascending, no dups
    }
  });

  it('walks forward from and including the anchor when reverse order is disabled', async () => {
    mockFetch.mockImplementation(async (_s, _id, _self, _g, start, end) => {
      const out = [];
      for (let s = start; s <= end; s++) out.push(gm(s));
      return out;
    });

    const res = await runHistory(new MessageApi(ctx).getGroupHistory(9999, 100, 5, 0, false));

    expect(res.map((message) => message.msgSeq)).toEqual([100, 101, 102, 103, 104]);
  });

  it('does not skip the anchor-side prefix when a forward window is short-capped', async () => {
    mockFetch.mockImplementation(async (_s, _id, _self, _g, start, end) => {
      const out = [];
      for (let s = Math.max(start, end - 9); s <= end; s++) out.push(gm(s));
      return out;
    });

    const res = await runHistory(new MessageApi(ctx).getGroupHistory(9999, 100, 20, 0, false));

    expect(res.map((message) => message.msgSeq)).toEqual(
      Array.from({ length: 20 }, (_, index) => 100 + index),
    );
  });

  it('uses the same forward semantics for private history', async () => {
    mockC2cFetch.mockImplementation(async (_s, _id, _self, _uid, start, end) => {
      const out = [];
      for (let s = start; s <= end; s++) {
        out.push({ ...gm(s + 10_000), kind: 'friend_message', ntMsgSeq: s });
      }
      return out;
    });

    const res = await runHistory(new MessageApi(ctx).getC2cHistory('u_friend', 300, 3, 0, false));

    expect(res.map((message) => message.ntMsgSeq)).toEqual([300, 301, 302]);
  });

  it('fetches the latest private page by timestamp without inventing a sequence anchor', async () => {
    mockC2cRoamFetch.mockResolvedValue({
      cursor: { time: 0, random: 0 },
      messages: [
        { ...gm(32742), kind: 'friend_message', ntMsgSeq: 63213, time: 1700000002 },
        { ...gm(32743), kind: 'friend_message', ntMsgSeq: 63214, time: 1700000001 },
      ],
    } as any);

    const result = await runHistory(
      new MessageApi(ctx).getC2cLatestHistory('u_friend', 20, 10001, 1700000100),
    );

    expect(mockC2cRoamFetch).toHaveBeenCalledWith(
      ctx,
      ctx.identity,
      10001,
      'u_friend',
      1700000100,
      20,
      0,
    );
    expect(result.map((message) => message.ntMsgSeq)).toEqual([63213, 63214]);
    expect(mockC2cFetch).not.toHaveBeenCalled();
  });

  it('follows the private roam cursor until the requested count is filled', async () => {
    mockC2cRoamFetch
      .mockResolvedValueOnce({
        cursor: { time: 1700000000, random: 7 },
        messages: [
          { ...gm(32744), kind: 'friend_message', ntMsgSeq: 63215, time: 1700000002 },
        ],
      } as any)
      .mockResolvedValueOnce({
        cursor: { time: 1699999900, random: 8 },
        messages: [
          { ...gm(32742), kind: 'friend_message', ntMsgSeq: 63213, time: 1700000000 },
          { ...gm(32743), kind: 'friend_message', ntMsgSeq: 63214, time: 1700000001 },
        ],
      } as any);

    const result = await runHistory(
      new MessageApi(ctx).getC2cLatestHistory('u_friend', 3, 10001, 1700000100),
    );

    expect(mockC2cRoamFetch).toHaveBeenNthCalledWith(
      1, ctx, ctx.identity, 10001, 'u_friend', 1700000100, 3, 0,
    );
    expect(mockC2cRoamFetch).toHaveBeenNthCalledWith(
      2, ctx, ctx.identity, 10001, 'u_friend', 1700000000, 2, 7,
    );
    expect(result.map((message) => message.ntMsgSeq)).toEqual([63213, 63214, 63215]);
  });

  it('rejects a stalled private roam cursor instead of returning a partial page', async () => {
    mockC2cRoamFetch.mockResolvedValue({
      cursor: { time: 1700000100, random: 0 },
      messages: [
        { ...gm(32742), kind: 'friend_message', ntMsgSeq: 63213, time: 1700000000 },
      ],
    } as any);

    const assertion = expect(
      new MessageApi(ctx).getC2cLatestHistory('u_friend', 2, 10001, 1700000100),
    ).rejects.toThrow('cursor did not advance');
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('rejects a partial private page when the request budget is exhausted', async () => {
    let page = 0;
    mockC2cRoamFetch.mockImplementation(async () => {
      page++;
      return {
        cursor: { time: 1700000100 - page, random: page },
        messages: [
          {
            ...gm(32000 + page),
            kind: 'friend_message',
            ntMsgSeq: 63000 + page,
            time: 1700000100 - page,
          },
        ],
      } as any;
    });

    const assertion = expect(
      new MessageApi(ctx).getC2cLatestHistory('u_friend', 20, 10001, 1700000200),
    ).rejects.toThrow('request budget exhausted');
    await vi.runAllTimersAsync();
    await assertion;
    expect(mockC2cRoamFetch).toHaveBeenCalledTimes(12);
  });

  it('stops forward pagination at the unsigned sequence ceiling', async () => {
    mockFetch.mockImplementation(async (_s, _id, _self, _g, start, end) => {
      const out = [];
      for (let s = start; s <= end; s++) out.push(gm(s));
      return out;
    });

    const res = await runHistory(
      new MessageApi(ctx).getGroupHistory(9999, 0xffff_fffe, 5, 0, false),
    );

    expect(res.map((message) => message.msgSeq)).toEqual([0xffff_fffe, 0xffff_ffff]);
  });

  it('stops at the sequence floor when fewer messages exist than requested', async () => {
    mockFetch.mockImplementation(async (_s, _id, _self, _g, start, end) => {
      const out = [];
      for (let s = start; s <= end; s++) out.push(gm(s));
      return out;
    });

    const res = await runHistory(new MessageApi(ctx).getGroupHistory(9999, 20, 100)); // only seq 1..20 exist
    expect(res.map((m) => m.msgSeq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('caps the request count and bounds the request loop', async () => {
    let calls = 0;
    mockFetch.mockImplementation(async (_s, _id, _self, _g, _start, end) => {
      calls++;
      return [gm(end)]; // one message per window → never reaches a large `want`
    });

    const res = await runHistory(new MessageApi(ctx).getGroupHistory(9999, 100_000, 9999));
    expect(calls).toBeLessThanOrEqual(12);     // HISTORY_MAX_REQUESTS
    expect(res.length).toBeLessThanOrEqual(200); // HISTORY_MAX_COUNT
  });

  it('rejects a failed later window instead of presenting partial history as complete', async () => {
    mockFetch
      .mockResolvedValueOnce([gm(200)])
      .mockRejectedValueOnce(new Error('history transport failed'));

    const assertion = expect(
      new MessageApi(ctx).getGroupHistory(9999, 200, 20),
    ).rejects.toThrow('history transport failed');
    await vi.runAllTimersAsync();
    await assertion;
  });

  it('returns [] for an invalid anchor without sending', async () => {
    expect(await new MessageApi(ctx).getGroupHistory(0, 100, 10)).toEqual([]);
    expect(await new MessageApi(ctx).getGroupHistory(9999, 0, 10)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
