// ptt-upload tests focus on the fingerprint (fast-upload) path: the
// regular load path goes through ffmpeg's silk encoder + the OS temp
// directory, which we don't want to exercise in a unit test. The
// fingerprint path covers most of what makes ptt-upload distinct
// (group/c2c requestId difference, command id mapping, NapCat-style
// bytesGeneralFlags, voiceFormat honouring).

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@snowluma/bridge/highway/pipeline', () => ({
  runNtv2Upload: vi.fn(async () => ({ msgInfo: { msgInfoBody: [], extBizInfo: {} } })),
  finalizeMediaMsgInfo: vi.fn(() => new Uint8Array([0xAA, 0xBB])),
  hexToBytes: vi.fn((hex: string) => new Uint8Array(hex.length / 2)),
}));

import * as pipeline from '@snowluma/bridge/highway/pipeline';
import { uploadPttMsgInfo, GROUP_PTT_CMD_ID, PRIVATE_PTT_CMD_ID } from '@snowluma/bridge/highway/ptt-upload';

const FINGERPRINT = {
  noByteFallback: true,
  md5Hex: 'aa',
  sha1Hex: 'bb',
  fileSize: 1234,
  duration: 5,
} as any;

describe('ptt-upload', () => {
  beforeEach(() => {
    vi.mocked(pipeline.runNtv2Upload).mockClear();
    vi.mocked(pipeline.finalizeMediaMsgInfo).mockClear();
  });

  it('group: 0x126E_100 + GROUP_PTT_CMD_ID + group-flavored bytesGeneralFlags', async () => {
    await uploadPttMsgInfo({} as any, true, 12345, FINGERPRINT);
    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect(args.oidbCmd).toBe(0x126E);
    expect(args.serviceCmd).toBe('OidbSvcTrpcTcp.0x126e_100');
    expect(args.requestId).toBe(1);   // group
    expect(args.businessType).toBe(3);
    expect(args.uploads[0]!.cmdId).toBe(GROUP_PTT_CMD_ID);

    const groupFlags = (args.extBizInfo as any).ptt.bytesGeneralFlags;
    expect(groupFlags).toEqual(
      new Uint8Array([0x9a, 0x01, 0x07, 0xaa, 0x03, 0x04, 0x08, 0x08, 0x12, 0x00]),
    );
  });

  it('c2c: 0x126D_100 + PRIVATE_PTT_CMD_ID + requestId=4 + c2c-flavored flags', async () => {
    await uploadPttMsgInfo({} as any, false, 'recipient-uid', FINGERPRINT);
    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect(args.oidbCmd).toBe(0x126D);
    expect(args.serviceCmd).toBe('OidbSvcTrpcTcp.0x126d_100');
    expect(args.requestId).toBe(4);
    expect(args.uploads[0]!.cmdId).toBe(PRIVATE_PTT_CMD_ID);

    const c2cFlags = (args.extBizInfo as any).ptt.bytesGeneralFlags;
    expect(c2cFlags.length).toBe(14);
    expect(c2cFlags[0]).toBe(0x9a);
  });

  it('fingerprint payload: zero bytes, fastOnlyError ready, voiceFormat defaults to 1', async () => {
    await uploadPttMsgInfo({} as any, true, 12345, FINGERPRINT);
    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect(args.uploads[0]!.bytes.length).toBe(0);
    expect(args.uploads[0]!.fastOnlyError).toMatch(/record fast-upload not available/);
    const fileInfo: any = (args.uploadInfo[0] as any).fileInfo;
    expect(fileInfo.type.voiceFormat).toBe(1);
    expect(fileInfo.time).toBe(5);
  });

  it('honours an explicit voiceFormat from the fingerprint', async () => {
    await uploadPttMsgInfo({} as any, true, 12345, { ...FINGERPRINT, voiceFormat: 2 });
    const fileInfo: any = (vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo[0] as any).fileInfo;
    expect(fileInfo.type.voiceFormat).toBe(2);
  });

  it('fingerprint mode rejects when md5Hex or sha1Hex is missing', async () => {
    await expect(
      uploadPttMsgInfo({} as any, true, 12345, { noByteFallback: true } as any),
    ).rejects.toThrow(/requires md5Hex/);
  });

  it('finalize is called without a defaultPic (ptt copies pic from server only)', async () => {
    await uploadPttMsgInfo({} as any, true, 12345, FINGERPRINT);
    const args = vi.mocked(pipeline.finalizeMediaMsgInfo).mock.calls[0]!;
    expect(args[1]).toBeUndefined();
  });
});
