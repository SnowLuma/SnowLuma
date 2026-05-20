import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbStrangerStatusResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import type {
  OidbAiVoiceListResp,
  OidbAiVoiceResp,
} from '@snowluma/proto-defs/oidb-actions/media';

// `encodeOidbEnv` / `decodeOidbEnv` are proton-bound pass-through wrappers
// (substituted at the call site with the inlined codec). Mocking them on
// the module object is a no-op — proton has already inlined the call.
// We mock `runOidb` (non-generic) to return real proton-encoded bytes
// that the production-side codec actually decodes.
vi.mock('../../src/bridge/bridge-oidb', async () => {
  const actual = await vi.importActual<typeof import('../../src/bridge/bridge-oidb')>(
    '../../src/bridge/bridge-oidb',
  );
  return {
    ...actual,
    runOidb: vi.fn(async () => new Uint8Array()),
    makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  };
});

import * as oidb from '../../src/bridge/bridge-oidb';
import { ExtrasApi, AiVoiceChatType } from '../../src/bridge/apis/extras';
import { mockBridge } from './_helpers';

describe('apis/extras / group todo (0xF90)', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockClear();
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
  });

  it.each([
    ['setGroupTodo', 'OidbSvcTrpcTcp.0xf90_1', 1] as const,
    ['completeGroupTodo', 'OidbSvcTrpcTcp.0xf90_2', 2] as const,
    ['cancelGroupTodo', 'OidbSvcTrpcTcp.0xf90_3', 3] as const,
  ])('%s dispatches the right subCmd with shared body', async (method, cmd, subCmd) => {
    const bridge = mockBridge();
    const api = new ExtrasApi(bridge as any);
    await (api as any)[method](12345, 9876543210n);
    const [, runCmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(runCmd).toBe(cmd);
    const [oidbCmd, sub, body] = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]!;
    expect(oidbCmd).toBe(0xF90);
    expect(sub).toBe(subCmd);
    expect(body).toEqual({ groupUin: 12345, msgSeq: 9876543210n });
  });
});

describe('apis/extras / getStrangerStatus (0xFE1_2)', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
  });

  it('issues the FE1_2 query with key=27372', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: { data: { status: { value: 5n } } } }),
    );
    await new ExtrasApi(bridge as any).getStrangerStatus(100200);
    const [, runCmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(runCmd).toBe('OidbSvcTrpcTcp.0xfe1_2');
    const [oidbCmd, sub, body] = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]!;
    expect(oidbCmd).toBe(0xFE1);
    expect(sub).toBe(2);
    expect(body).toMatchObject({ uin: 100200, key: [{ key: 27372 }] });
  });

  it('low-band values (≤10) map to status*10 with ext_status=0', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: { data: { status: { value: 7n } } } }),
    );
    expect(await new ExtrasApi(bridge as any).getStrangerStatus(1)).toEqual({ status: 70, ext_status: 0 });
  });

  it('high-band values decompose into the (0xff00 + (>>16 & 0xff)) status word', async () => {
    const bridge = mockBridge();
    // value 0x42F100: bits 8-15 (the 0xff00 mask) = 0xF100;
    //                bits 16-23 (>>16 & 0xff)    = 0x42.
    // ext_status = 0xF100 + 0x42 = 0xF142.
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: { data: { status: { value: 0x42F100n } } } }),
    );
    const status = await new ExtrasApi(bridge as any).getStrangerStatus(1);
    expect(status).toEqual({ status: 10, ext_status: 0xF142 });
  });

  it('returns null when the runner throws (transport error)', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockRejectedValueOnce(new Error('boom'));
    expect(await new ExtrasApi(bridge as any).getStrangerStatus(1)).toBeNull();
  });

  it('returns null when the server omits the status field', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbStrangerStatusResp>>({ body: {} }),
    );
    expect(await new ExtrasApi(bridge as any).getStrangerStatus(1)).toBeNull();
  });
});

describe('apis/extras / AI voice (0x929D / 0x929B)', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
  });

  it('fetchAiVoiceList sends 0x929D_0 and returns server content verbatim', async () => {
    const bridge = mockBridge();
    const fake = [
      { category: 'cute', voices: [{ voiceId: 'v1', voiceDisplayName: 'V1', voiceExampleUrl: 'http://x' }] },
    ];
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbAiVoiceListResp>>({ body: { content: fake } } as any),
    );
    const out = await new ExtrasApi(bridge as any).fetchAiVoiceList(4242, AiVoiceChatType.Sound);
    expect(out).toEqual(fake);
    const [, runCmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(runCmd).toBe('OidbSvcTrpcTcp.0x929d_0');
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(body).toEqual({ groupUin: 4242, chatType: 1 });
  });

  it('fetchAiVoiceList returns [] when server replies with no content', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<OidbAiVoiceListResp>>({ body: {} }),
    );
    const out = await new ExtrasApi(bridge as any).fetchAiVoiceList(1, 1);
    expect(out).toEqual([]);
  });

  it('fetchAiVoice retries while msgInfo is empty, returns the first IndexNode it sees', async () => {
    const bridge = mockBridge();
    // subType is non-zero so proto3 doesn't omit it from the wire (the
    // re-decoded object must include the field for the matcher to spot it).
    const node = { fileUuid: 'uuid-1', subType: 1 };
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { statusCode: 2 } }))
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { msgInfo: { msgInfoBody: [] } } as any }))
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { msgInfo: { msgInfoBody: [{ index: node }] } } as any }));
    const out = await new ExtrasApi(bridge as any).fetchAiVoice(100, 'voice-id', 'hi', AiVoiceChatType.Sound);
    expect(out).toMatchObject(node);
    expect(vi.mocked(oidb.runOidb)).toHaveBeenCalledTimes(3);
    const [, runCmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(runCmd).toBe('OidbSvcTrpcTcp.0x929b_0');
    const body = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2] as any;
    expect(body).toMatchObject({
      groupUin: 100, voiceId: 'voice-id', text: 'hi', chatType: 1,
    });
    // sessionId is randomized but must be a uint32.
    expect(body.session.sessionId).toBeTypeOf('number');
    expect(body.session.sessionId).toBeGreaterThanOrEqual(0);
    expect(body.session.sessionId).toBeLessThanOrEqual(0xFFFFFFFF);
  });

  it('fetchAiVoice throws after exhausting the retry budget', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValue(
      protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { statusCode: 1 } }),
    );
    await expect(new ExtrasApi(bridge as any).fetchAiVoice(1, 'v', 't', 1, 3)).rejects.toThrow(
      /AI voice synthesis did not complete/,
    );
    expect(vi.mocked(oidb.runOidb)).toHaveBeenCalledTimes(3);
  });

  it('fetchAiVoice keeps the same sessionId across retries', async () => {
    const bridge = mockBridge();
    const node = { fileUuid: 'uuid', subType: 0 };
    vi.mocked(oidb.runOidb)
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: {} }))
      .mockResolvedValueOnce(protobuf_encode<OidbBase<OidbAiVoiceResp>>({ body: { msgInfo: { msgInfoBody: [{ index: node }] } } as any }));
    await new ExtrasApi(bridge as any).fetchAiVoice(1, 'v', 't', 1);
    const first = (vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2] as any).session.sessionId;
    const second = (vi.mocked(oidb.makeOidbEnvelope).mock.calls[1]![2] as any).session.sessionId;
    expect(first).toBe(second);
  });
});
