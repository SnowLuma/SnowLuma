// MessageApi.getGroupHistory walk-back loop: chunking, dedup, server-short-cap
// handling, floor termination, slice(-want). fetchGroupMessageRange is mocked
// so this exercises the loop/cursor logic, not the wire decode (covered in
// packages/protocol/tests/msg-push/fetch-group-history.test.ts).

import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/protocol/msg-push', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@snowluma/protocol/msg-push')>();
  return { ...actual, fetchGroupMessageRange: vi.fn() };
});

import { fetchGroupMessageRange } from '@snowluma/protocol/msg-push';
import { MessageApi } from '../src/bridge/apis/message';

const mockFetch = vi.mocked(fetchGroupMessageRange);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function gm(seq: number): any {
  return {
    kind: 'group_message', time: 0, selfUin: 0, senderUin: 1, msgSeq: seq,
    msgId: seq, elements: [], groupId: 9999, senderNick: '', senderCard: '', senderRole: '',
  };
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ctx = { identity: {}, sendRawPacket: vi.fn() } as any;

describe('MessageApi.getGroupHistory walk-back', () => {
  beforeEach(() => mockFetch.mockReset());

  it('walks back across short-capped windows, dedups, returns newest `want` ascending', async () => {
    // Server caps every window to its newest 10 sequences → forces walk-back.
    mockFetch.mockImplementation(async (_s, _id, _self, _g, start, end) => {
      const out = [];
      for (let s = Math.max(start, end - 9); s <= end; s++) out.push(gm(s));
      return out;
    });

    const res = await new MessageApi(ctx).getGroupHistory(9999, 200, 50);

    expect(res).toHaveLength(50);
    expect(res[0].msgSeq).toBe(151); // newest 50 ending at 200 → 151..200
    expect(res[res.length - 1].msgSeq).toBe(200);
    for (let i = 1; i < res.length; i++) {
      expect(res[i].msgSeq).toBeGreaterThan(res[i - 1].msgSeq); // strictly ascending, no dups
    }
  });

  it('stops at the sequence floor when fewer messages exist than requested', async () => {
    mockFetch.mockImplementation(async (_s, _id, _self, _g, start, end) => {
      const out = [];
      for (let s = start; s <= end; s++) out.push(gm(s));
      return out;
    });

    const res = await new MessageApi(ctx).getGroupHistory(9999, 20, 100); // only seq 1..20 exist
    expect(res.map((m) => m.msgSeq)).toEqual(Array.from({ length: 20 }, (_, i) => i + 1));
  });

  it('caps the request count and bounds the request loop', async () => {
    let calls = 0;
    mockFetch.mockImplementation(async (_s, _id, _self, _g, _start, end) => {
      calls++;
      return [gm(end)]; // one message per window → never reaches a large `want`
    });

    const res = await new MessageApi(ctx).getGroupHistory(9999, 100_000, 9999);
    expect(calls).toBeLessThanOrEqual(12);     // HISTORY_MAX_REQUESTS
    expect(res.length).toBeLessThanOrEqual(200); // HISTORY_MAX_COUNT
  });

  it('returns [] for an invalid anchor without sending', async () => {
    expect(await new MessageApi(ctx).getGroupHistory(0, 100, 10)).toEqual([]);
    expect(await new MessageApi(ctx).getGroupHistory(9999, 0, 10)).toEqual([]);
    expect(mockFetch).not.toHaveBeenCalled();
  });
});
