import { describe, it, expect, vi, beforeEach } from 'vitest';

// Same stub-the-oidb-runner pattern as actions/group-admin.test.ts —
// we don't care about wire bytes, just that each function targets the
// right cmd / subCmd / schema.
vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => ({})),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as extras from '../../src/bridge/actions/extras';
import * as schemas from '../../src/bridge/proto/oidb-action';
import { mockBridge } from './_helpers';

describe('actions/extras / group todo (0xF90)', () => {
  beforeEach(() => vi.mocked(oidb.runOidb).mockClear());

  it.each([
    ['setGroupTodo', extras.setGroupTodo, 'OidbSvcTrpcTcp.0xf90_1', 1],
    ['completeGroupTodo', extras.completeGroupTodo, 'OidbSvcTrpcTcp.0xf90_2', 2],
    ['cancelGroupTodo', extras.cancelGroupTodo, 'OidbSvcTrpcTcp.0xf90_3', 3],
  ] as const)('%s dispatches the right subCmd with shared body', async (_name, fn, cmd, subCmd) => {
    const bridge = mockBridge();
    await fn(bridge as any, 12345, 9876543210n);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe(cmd);
    expect(call.oidbCmd).toBe(0xF90);
    expect(call.subCmd).toBe(subCmd);
    expect(call.request.schema).toBe(schemas.OidbGroupTodoSchema);
    expect(call.request.value).toEqual({ groupUin: 12345, msgSeq: 9876543210n });
  });
});

describe('actions/extras / getStrangerStatus (0xFE1_2)', () => {
  beforeEach(() => vi.mocked(oidb.runOidb).mockClear());

  it('issues the FE1_2 query with key=27372', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({ data: { status: { value: 5n } } } as any);
    await extras.getStrangerStatus(bridge as any, 100200);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0xfe1_2');
    expect(call.oidbCmd).toBe(0xFE1);
    expect(call.subCmd).toBe(2);
    expect(call.request.value).toMatchObject({ uin: 100200, key: [{ key: 27372 }] });
  });

  it('low-band values (≤10) map to status*10 with ext_status=0', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({ data: { status: { value: 7n } } } as any);
    expect(await extras.getStrangerStatus(bridge as any, 1)).toEqual({ status: 70, ext_status: 0 });
  });

  it('high-band values decompose into the (0xff00 + (>>16 & 0xff)) status word', async () => {
    const bridge = mockBridge();
    // value 0x42F100: bits 8-15 (the 0xff00 mask) = 0xF100;
    //                bits 16-23 (>>16 & 0xff)    = 0x42.
    // ext_status = 0xF100 + 0x42 = 0xF142.
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({ data: { status: { value: 0x42F100n } } } as any);
    const status = await extras.getStrangerStatus(bridge as any, 1);
    expect(status).toEqual({ status: 10, ext_status: 0xF142 });
  });

  it('returns null when the runner throws (transport error)', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockRejectedValueOnce(new Error('boom'));
    expect(await extras.getStrangerStatus(bridge as any, 1)).toBeNull();
  });

  it('returns null when the server omits the status field', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({} as any);
    expect(await extras.getStrangerStatus(bridge as any, 1)).toBeNull();
  });
});

describe('actions/extras / AI voice (0x929D / 0x929B)', () => {
  beforeEach(() => vi.mocked(oidb.runOidb).mockClear());

  it('fetchAiVoiceList sends 0x929D_0 and returns server content verbatim', async () => {
    const bridge = mockBridge();
    const fake = [
      { category: 'cute', voices: [{ voiceId: 'v1', voiceDisplayName: 'V1', voiceExampleUrl: 'http://x' }] },
    ];
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({ content: fake } as any);
    const out = await extras.fetchAiVoiceList(bridge as any, 4242, extras.AiVoiceChatType.Sound);
    expect(out).toEqual(fake);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0x929d_0');
    expect(call.request.value).toEqual({ groupUin: 4242, chatType: 1 });
  });

  it('fetchAiVoiceList returns [] when server replies with no content', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({} as any);
    const out = await extras.fetchAiVoiceList(bridge as any, 1, 1 as any);
    expect(out).toEqual([]);
  });

  it('fetchAiVoice retries while msgInfo is empty, returns the first IndexNode it sees', async () => {
    const bridge = mockBridge();
    const node = { fileUuid: 'uuid-1', subType: 0 };
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce({ statusCode: 2 } as any)
      .mockResolvedValueOnce({ msgInfo: { msgInfoBody: [] } } as any)
      .mockResolvedValueOnce({ msgInfo: { msgInfoBody: [{ index: node }] } } as any);
    const out = await extras.fetchAiVoice(bridge as any, 100, 'voice-id', 'hi', extras.AiVoiceChatType.Sound);
    expect(out).toBe(node);
    expect(vi.mocked(oidb.runOidb)).toHaveBeenCalledTimes(3);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0x929b_0');
    expect(call.request.value).toMatchObject({
      groupUin: 100, voiceId: 'voice-id', text: 'hi', chatType: 1,
    });
    // sessionId is randomized but must be a uint32.
    expect((call.request.value as any).session.sessionId).toBeTypeOf('number');
    expect((call.request.value as any).session.sessionId).toBeGreaterThanOrEqual(0);
    expect((call.request.value as any).session.sessionId).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('fetchAiVoice throws after exhausting the retry budget', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValue({ statusCode: 1 } as any);
    await expect(extras.fetchAiVoice(bridge as any, 1, 'v', 't', 1 as any, 3)).rejects.toThrow(
      /AI voice synthesis did not complete/,
    );
    expect(vi.mocked(oidb.runOidb)).toHaveBeenCalledTimes(3);
  });

  it('fetchAiVoice keeps the same sessionId across retries', async () => {
    const bridge = mockBridge();
    const node = { fileUuid: 'uuid', subType: 0 };
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce({} as any)
      .mockResolvedValueOnce({ msgInfo: { msgInfoBody: [{ index: node }] } } as any);
    await extras.fetchAiVoice(bridge as any, 1, 'v', 't', 1 as any);
    const first = (vi.mocked(oidb.runOidb).mock.calls[0]![1].request.value as any).session.sessionId;
    const second = (vi.mocked(oidb.runOidb).mock.calls[1]![1].request.value as any).session.sessionId;
    expect(first).toBe(second);
  });
});
