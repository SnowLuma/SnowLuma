// image-upload tests: with the pipeline mocked out, these check the
// shape of the params each call passes — oidbCmd / serviceCmd / pic
// extBizInfo, the Highway cmdId mapping for group vs c2c, and the
// fast-upload (fingerprint) path.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@snowluma/protocol/highway/pipeline', () => ({
  runNtv2Upload: vi.fn(async () => ({ msgInfo: { msgInfoBody: [], extBizInfo: {} } })),
  finalizeMediaMsgInfo: vi.fn(() => new Uint8Array([0xCA, 0xFE])),
  hexToBytes: vi.fn((hex: string) => new Uint8Array(hex.length / 2)),
}));

vi.mock('@snowluma/protocol/highway/utils', () => ({
  loadBinarySource: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), fileName: 'src.jpg' })),
  computeHashes: vi.fn(() => ({
    md5: new Uint8Array(16),
    sha1: new Uint8Array(20),
    md5Hex: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    sha1Hex: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  })),
  detectImageFormat: vi.fn(() => ({ format: 1000, width: 800, height: 600 })),
}));

import * as pipeline from '@snowluma/protocol/highway/pipeline';
import * as utils from '@snowluma/protocol/highway/utils';
import { uploadImageMsgInfo } from '@snowluma/protocol/highway/image-upload';
import { GROUP_IMAGE_CMD_ID, PRIVATE_IMAGE_CMD_ID } from '@snowluma/protocol/highway';

describe('image-upload', () => {
  beforeEach(() => {
    vi.mocked(pipeline.runNtv2Upload).mockClear();
    vi.mocked(pipeline.finalizeMediaMsgInfo).mockClear();
    vi.mocked(utils.loadBinarySource).mockClear();
  });

  it('group: uses 0x11C4_100 + GROUP_IMAGE_CMD_ID and tags scene as group', async () => {
    const out = await uploadImageMsgInfo({} as any, true, 12345, { url: 'http://x' } as any);
    expect(out).toEqual(new Uint8Array([0xCA, 0xFE]));

    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect(args.oidbCmd).toBe(0x11C4);
    expect(args.serviceCmd).toBe('OidbSvcTrpcTcp.0x11c4_100');
    expect(args.requestId).toBe(1);
    expect(args.businessType).toBe(1);
    expect(args.compatQmsgSceneType).toBe(2);
    expect(args.uploads[0]!.cmdId).toBe(GROUP_IMAGE_CMD_ID);
    expect((args.extBizInfo as any).pic.reserveTroop).toBeDefined();
    expect((args.extBizInfo as any).pic.reserveC2c).toBeUndefined();
  });

  it('c2c: uses 0x11C5_100 + PRIVATE_IMAGE_CMD_ID and tags scene as c2c', async () => {
    await uploadImageMsgInfo({} as any, false, 'recipient-uid', { url: 'http://x' } as any);
    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect(args.oidbCmd).toBe(0x11C5);
    expect(args.serviceCmd).toBe('OidbSvcTrpcTcp.0x11c5_100');
    expect(args.compatQmsgSceneType).toBe(1);
    expect(args.uploads[0]!.cmdId).toBe(PRIVATE_IMAGE_CMD_ID);
    expect((args.extBizInfo as any).pic.reserveC2c).toBeDefined();
    expect((args.extBizInfo as any).pic.reserveTroop).toBeUndefined();
  });

  it('uses receive-side imageUrl when url/fileId are absent', async () => {
    await uploadImageMsgInfo(
      {} as any,
      true,
      12345,
      { type: 'image', imageUrl: 'https://gchat.qpic.cn/received.jpg' },
    );
    expect(utils.loadBinarySource).toHaveBeenCalledWith(
      'https://gchat.qpic.cn/received.jpg',
      'image',
    );
  });

  it('encodes the detected picFormat and image dimensions into fileInfo', async () => {
    await uploadImageMsgInfo({} as any, true, 12345, { url: 'http://x' } as any);
    const fileInfo = (vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo[0] as any).fileInfo;
    expect(fileInfo.type.picFormat).toBe(1000);
    expect(fileInfo.width).toBe(800);
    expect(fileInfo.height).toBe(600);
    expect(fileInfo.original).toBe(1);
  });

  it('forwards subType=1 (sticker) into bizType + Chinese textSummary `[动画表情]`', async () => {
    // QQ chat-list bubble preview text — must match the literal
    // strings mobile QQ / Lagrange.Core / NapCat all emit.
    await uploadImageMsgInfo({} as any, true, 12345, { url: 'http://x', subType: 1 } as any);
    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect((args.extBizInfo as any).pic.bizType).toBe(1);
    expect((args.extBizInfo as any).pic.textSummary).toBe('[动画表情]');
  });

  it('fingerprint path (noByteFallback): zero bytes, fastOnly error message ready', async () => {
    await uploadImageMsgInfo({} as any, true, 12345, {
      noByteFallback: true, md5Hex: 'aa', sha1Hex: 'bb', summary: '[图片]',
    } as any);
    const sub = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploads[0]!;
    expect(sub.bytes.length).toBe(0);
    expect(sub.fastOnlyError).toMatch(/fast-upload not available/);
  });

  it('fingerprint path rejects when md5Hex or sha1Hex is missing', async () => {
    await expect(uploadImageMsgInfo({} as any, true, 12345, {
      noByteFallback: true,
    } as any)).rejects.toThrow(/requires md5Hex/);
  });

  it('finalize is invoked with pic defaults for image (Chinese `[图片]`)', async () => {
    await uploadImageMsgInfo({} as any, true, 12345, { url: 'http://x', subType: 0 } as any);
    expect(pipeline.finalizeMediaMsgInfo).toHaveBeenCalledOnce();
    const [, defaultPic] = vi.mocked(pipeline.finalizeMediaMsgInfo).mock.calls[0]!;
    expect(defaultPic).toEqual({ bizType: 0, textSummary: '[图片]' });
  });

  it('caller-supplied summary wins over the Chinese default', async () => {
    // OneBot clients can pass `summary: '[心形图片]'` (or any custom
    // text) — that overrides our default and goes through verbatim.
    await uploadImageMsgInfo({} as any, true, 12345, {
      url: 'http://x', subType: 0, summary: '[custom-bubble]',
    } as any);
    const [, defaultPic] = vi.mocked(pipeline.finalizeMediaMsgInfo).mock.calls[0]!;
    expect(defaultPic).toEqual({ bizType: 0, textSummary: '[custom-bubble]' });
  });
});
