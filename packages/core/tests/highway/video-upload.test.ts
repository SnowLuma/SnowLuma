// video-upload tests cover the fingerprint (fast-upload) path. The
// regular load path exercises ffmpeg + the OS temp dir + a streaming
// SHA1 implementation; that machinery has its own seams worth testing
// separately, and isn't what makes video-upload distinct at the API
// surface.
//
// What we're checking here: the two-sub-file shape (main + thumb), the
// thumb's source routing (`upload.subFileInfos[0]`), the per-sub-file
// fastOnlyError difference (main has it; thumb doesn't — FALLBACK_THUMB
// always provides bytes), and the video-specific OIDB fields.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@snowluma/protocol/highway/pipeline', () => ({
  runNtv2Upload: vi.fn(async () => ({ msgInfo: { msgInfoBody: [], extBizInfo: {} } })),
  finalizeMediaMsgInfo: vi.fn(() => new Uint8Array([0x12, 0x34])),
  hexToBytes: vi.fn((hex: string) => new Uint8Array(hex.length / 2)),
}));

import * as pipeline from '@snowluma/protocol/highway/pipeline';
import {
  uploadVideoMsgInfo,
  GROUP_VIDEO_CMD_ID,
  GROUP_VIDEO_THUMB_CMD_ID,
  PRIVATE_VIDEO_CMD_ID,
  PRIVATE_VIDEO_THUMB_CMD_ID,
} from '@snowluma/protocol/highway/video-upload';

const FINGERPRINT = {
  noByteFallback: true,
  md5Hex: 'aa',
  sha1Hex: 'bb',
  fileSize: 1024,
  width: 320,
  height: 240,
  duration: 10,
  videoFormat: 0,
} as any;

describe('video-upload', () => {
  beforeEach(() => {
    vi.mocked(pipeline.runNtv2Upload).mockClear();
    vi.mocked(pipeline.finalizeMediaMsgInfo).mockClear();
  });

  it('group: 0x11EA_100 + GROUP_VIDEO_CMD_ID for main, GROUP_VIDEO_THUMB_CMD_ID for thumb', async () => {
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect(args.oidbCmd).toBe(0x11EA);
    expect(args.serviceCmd).toBe('OidbSvcTrpcTcp.0x11ea_100');
    expect(args.requestId).toBe(3);
    expect(args.businessType).toBe(2);
    expect(args.compatQmsgSceneType).toBe(2);
    expect(args.uploads).toHaveLength(2);
    expect(args.uploads[0]!.cmdId).toBe(GROUP_VIDEO_CMD_ID);
    expect(args.uploads[1]!.cmdId).toBe(GROUP_VIDEO_THUMB_CMD_ID);
  });

  it('c2c: 0x11E9_100 + PRIVATE cmd ids', async () => {
    await uploadVideoMsgInfo({} as any, false, 'recipient-uid', FINGERPRINT);
    const args = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0];
    expect(args.oidbCmd).toBe(0x11E9);
    expect(args.uploads[0]!.cmdId).toBe(PRIVATE_VIDEO_CMD_ID);
    expect(args.uploads[1]!.cmdId).toBe(PRIVATE_VIDEO_THUMB_CMD_ID);
  });

  it('main file routes via "top", thumb routes via subFileInfos[0]', async () => {
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploads = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploads;
    expect(uploads[0]!.source).toBe('top');
    expect(uploads[0]!.subFileIndex).toBe(0);
    expect(uploads[1]!.source).toBe(0);
    expect(uploads[1]!.subFileIndex).toBe(1);
  });

  it('main fastOnlyError is set; thumb is silent (FALLBACK_THUMB always has bytes)', async () => {
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploads = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploads;
    expect(uploads[0]!.fastOnlyError).toMatch(/video fast-upload not available/);
    expect(uploads[1]!.fastOnlyError).toBeUndefined();
  });

  it('main file distrusts a server fast-path (forceFullOnFastPath); thumb does not (#145)', async () => {
    // Group/c2c video resources expire server-side: a fast-path hit can
    // reference a stale object the receiver shows as "资源已过期", so the
    // main file forces a fresh full upload. The thumb stays fast-path-OK.
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploads = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploads;
    expect(uploads[0]!.forceFullOnFastPath).toBe(true);
    expect(uploads[1]!.forceFullOnFastPath).toBeUndefined();
  });

  it('uploadInfo carries TWO entries (main mp4 + thumb jpg) with subFileType 0 and 100', async () => {
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploadInfo = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect(uploadInfo).toHaveLength(2);
    expect((uploadInfo[0] as any).subFileType).toBe(0);
    expect((uploadInfo[1] as any).subFileType).toBe(100);
    expect((uploadInfo[0] as any).fileInfo.type.type).toBe(2); // video
    expect((uploadInfo[1] as any).fileInfo.type.type).toBe(1); // pic (thumb)
  });

  it('main video carries the real `time` (duration in seconds) — regression: was 0', async () => {
    // NTV2 server bakes the `time` field into the resulting MsgInfo
    // bytes that ride along as `commonElem.pbElem`; the receiver
    // reads it back via `VideoFile.fileTime` and renders it as the
    // playable duration. NapCat ships `time: 0` only because it sits
    // on top of QQ-NT's IPC layer which patches the value in before
    // the wire send; we're a protocol-direct client (same position
    // as acidify) and must populate it ourselves. Without this the
    // receiver shows "00:00" on every video the bot sends.
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploadInfo = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((uploadInfo[0] as any).fileInfo.time).toBe(10); // matches FINGERPRINT.duration
    expect((uploadInfo[1] as any).fileInfo.time).toBe(0);  // thumb stays at 0 (matches acidify)
  });

  it('thumb falls back to a synthesized 1x1 PNG with real bytes', async () => {
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploads = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploads;
    expect(uploads[1]!.bytes.length).toBeGreaterThan(0); // FALLBACK_THUMB is non-empty
  });

  it('main file uses per-1MB-block sha1 (an Uint8Array[]) — fingerprint path uses an empty array', async () => {
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploads = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploads;
    // The fingerprint payload sets sha1Blocks: [] (no real bytes to chunk).
    expect(Array.isArray(uploads[0]!.sha1)).toBe(true);
    expect((uploads[0]!.sha1 as Uint8Array[]).length).toBe(0);
  });

  it('fingerprint mode rejects when md5Hex or sha1Hex is missing', async () => {
    await expect(
      uploadVideoMsgInfo({} as any, true, 12345, { noByteFallback: true } as any),
    ).rejects.toThrow(/requires md5Hex/);
  });

  it('finalize is called without a defaultPic', async () => {
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const args = vi.mocked(pipeline.finalizeMediaMsgInfo).mock.calls[0]!;
    expect(args[1]).toBeUndefined();
  });
});
