import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x990Resp,
  Oidb0x112eResp,
} from '@snowluma/proto-defs/oidb-actions/base';

// `encodeOidbEnv` / `decodeOidbEnv` are proton-bound pass-through wrappers
// — the plugin substitutes them at the call site with the inlined codec,
// so mocking them on the module object is a no-op. We mock `runOidb`
// (non-generic, untouched by proton) to return real proton-encoded bytes
// that the production-side codec then actually decodes.
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
import * as misc from '../../src/bridge/actions/misc';
import { mockBridge } from './_helpers';

describe('actions/misc', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
  });

  it('translateEn2Zh returns dstWords when present', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<Oidb0x990Resp>>({
        body: { translateResp: { dstWords: ['你好', '世界'] } } as any,
      }),
    );
    const out = await misc.translateEn2Zh(bridge as any, ['hello', 'world']);
    expect(out).toEqual(['你好', '世界']);
  });

  it('translateEn2Zh throws on empty response', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<Oidb0x990Resp>>({ body: {} }),
    );
    await expect(misc.translateEn2Zh(bridge as any, ['hello']))
      .rejects.toThrow(/empty/);
  });

  it('getMiniAppArk rejects unsupported types', async () => {
    const bridge = mockBridge();
    await expect(
      misc.getMiniAppArk(bridge as any, 'youtube', 't', 'd', 'p', 'u'),
    ).rejects.toThrow(/unsupported type/);
  });

  it('getMiniAppArk routes to LightAppSvc with the encoded body', async () => {
    // sendRawPacket is what the action calls; we need a deterministic
    // successful response with a decodable body. Easiest: stub the
    // raw packet with the encoded response we expect to come back.
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: null,
      })) as any,
    });
    // With null responseData, the action should throw on decode — that
    // still proves the right serviceCmd was used.
    await expect(misc.getMiniAppArk(bridge as any, 'bili', 't', 'd', 'p', 'u')).rejects.toThrow();
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    expect(bridge.sendRawPacket.mock.calls[0]![0])
      .toBe('LightAppSvc.mini_app_share.AdaptShareInfo');
  });

  it('clickInlineKeyboardButton returns shaped result', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<Oidb0x112eResp>>({
        body: { result: 1, errMsg: 'ok', promptText: 'hi' } as any,
      }),
    );
    const out = await misc.clickInlineKeyboardButton(bridge as any, 1, 2, 'btn', 'data', 100);
    expect(out).toMatchObject({ result: 1, errMsg: 'ok', promptText: 'hi', status: 0 });
  });

  it('sendGroupSign dispatches to 0xEB7_1', async () => {
    const bridge = mockBridge();
    await misc.sendGroupSign(bridge as any, 12345);
    const [, cmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0xEB7_1');
  });
});
