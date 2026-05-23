import { describe, it, expect, vi } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x990Resp,
  Oidb0x112eResp,
} from '@snowluma/proto-defs/oidb-actions/base';

// Post-namespace migration: MiscApi forwards 3 OIDB cmds through
// @snowluma/protocol/oidb-services/misc namespaces. The non-OIDB
// `getMiniAppArk` (LightAppSvc) stays inline on the facade. Tests
// hit bridge.sendRawPacket directly.
import { MiscApi } from '../../src/bridge/apis/misc';
import { mockBridge } from './_helpers';

function packResponse(body: Uint8Array) {
  return {
    success: true, gotResponse: true, errorCode: 0, errorMessage: '',
    responseData: Buffer.from(body),
  };
}

describe('apis/misc', () => {
  it('translateEn2Zh returns dstWords when present', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<Oidb0x990Resp>>({
        body: { translateResp: { dstWords: ['你好', '世界'] } } as any,
      }),
    ));
    const out = await new MiscApi(bridge as any).translateEn2Zh(['hello', 'world']);
    expect(out).toEqual(['你好', '世界']);
  });

  it('translateEn2Zh throws on empty response', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<Oidb0x990Resp>>({ body: {} }),
    ));
    await expect(new MiscApi(bridge as any).translateEn2Zh(['hello']))
      .rejects.toThrow(/empty/);
  });

  it('getMiniAppArk rejects unsupported types', async () => {
    const bridge = mockBridge();
    await expect(
      new MiscApi(bridge as any).getMiniAppArk('youtube', 't', 'd', 'p', 'u'),
    ).rejects.toThrow(/unsupported type/);
  });

  it('getMiniAppArk routes to LightAppSvc with the encoded body', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: null,
      })) as any,
    });
    await expect(new MiscApi(bridge as any).getMiniAppArk('bili', 't', 'd', 'p', 'u')).rejects.toThrow();
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    expect(bridge.sendRawPacket.mock.calls[0]![0])
      .toBe('LightAppSvc.mini_app_share.AdaptShareInfo');
  });

  it('clickInlineKeyboardButton returns shaped result', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce(packResponse(
      protobuf_encode<OidbBase<Oidb0x112eResp>>({
        body: { result: 1, errMsg: 'ok', promptText: 'hi' } as any,
      }),
    ));
    const out = await new MiscApi(bridge as any).clickInlineKeyboardButton(1, 2, 'btn', 'data', 100);
    expect(out).toMatchObject({ result: 1, errMsg: 'ok', promptText: 'hi', status: 0 });
  });

  it('sendGroupSign dispatches to 0xEB7_1 (uppercase preserved)', async () => {
    const bridge = mockBridge();
    await new MiscApi(bridge as any).sendGroupSign(12345);
    const [cmd] = bridge.sendRawPacket.mock.calls[0]!;
    // **Important**: this cmd keeps the historic UPPERCASE EB7 wire
    // name. Default scheme would emit lowercase; the namespace
    // overrides `wireName` to preserve byte-equality with NTQQ wire.
    expect(cmd).toBe('OidbSvcTrpcTcp.0xEB7_1');
  });
});
