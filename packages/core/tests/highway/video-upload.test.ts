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
import { promises as fsp } from 'fs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { pathToFileURL } from 'url';
import { computeHashes } from '@snowluma/protocol/highway/utils';

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

  it('does NOT set a force-full retry flag on the main file (#145 — proven ineffective)', async () => {
    // The old forceFullOnFastPath retry was removed: real-machine + kernel RE
    // showed it never forces a fresh upload (the server fast-paths by md5
    // metadata regardless of tryFastUploadCompleted). An expired-but-indexed
    // video resource is a platform limitation, not an upload-flow fix.
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const uploads = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploads;
    expect((uploads[0] as unknown as Record<string, unknown>).forceFullOnFastPath).toBeUndefined();
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

  it('[#145] group video carries real width/height; c2c stays 0/0', async () => {
    // A real QQ group video's MsgInfo has real dimensions (e.g. 296x640);
    // sending 0x0 makes QQ-NT receivers render 文件已过期 even though the
    // resource is fresh (verified on tempserver: 0x0 → expired, real dims →
    // renders). c2c is left at 0 — the server rejects non-zero dims there.
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const groupInfo = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((groupInfo[0] as any).fileInfo.width).toBe(320);  // FINGERPRINT.width
    expect((groupInfo[0] as any).fileInfo.height).toBe(240); // FINGERPRINT.height

    vi.mocked(pipeline.runNtv2Upload).mockClear();
    await uploadVideoMsgInfo({} as any, false, 'recipient-uid', FINGERPRINT);
    const c2cInfo = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((c2cInfo[0] as any).fileInfo.width).toBe(0);
    expect((c2cInfo[0] as any).fileInfo.height).toBe(0);
  });

  it('[#145] fast-upload with 0x0 dims (e.g. forwarding a dimensionless video) falls back to portrait for group', async () => {
    // A forwarded video whose cached dims are 0 must NOT ship 0x0 to a group
    // (→ 文件已过期). videoPayloadFromFingerprint substitutes a neutral 720x1280
    // portrait; c2c stays 0 (server rejects non-zero there).
    const noDims = { ...FINGERPRINT, width: 0, height: 0 } as any;
    await uploadVideoMsgInfo({} as any, true, 12345, noDims);
    const groupInfo = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((groupInfo[0] as any).fileInfo.width).toBe(720);
    expect((groupInfo[0] as any).fileInfo.height).toBe(1280);

    vi.mocked(pipeline.runNtv2Upload).mockClear();
    await uploadVideoMsgInfo({} as any, false, 'recipient-uid', noDims);
    const c2cInfo = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((c2cInfo[0] as any).fileInfo.width).toBe(0);
    expect((c2cInfo[0] as any).fileInfo.height).toBe(0);
  });

  it('[#145] zero-trust: fallback cover declared dims equal the video fallback (content == declared)', async () => {
    // The fast-upload cover is a real 720x1280 image; the thumb sub-file must
    // declare those same pixels, not a 1x1 lying about its size, and they match
    // the video fallback so tile + cover agree.
    const noDims = { ...FINGERPRINT, width: 0, height: 0 } as any;
    await uploadVideoMsgInfo({} as any, true, 12345, noDims);
    const info = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((info[0] as any).fileInfo.width).toBe(720);   // video tile
    expect((info[0] as any).fileInfo.height).toBe(1280);
    expect((info[1] as any).fileInfo.width).toBe(720);   // cover sub-file (subFileType 100)
    expect((info[1] as any).fileInfo.height).toBe(1280);
  });

  it('[#145] zero-trust: cached duration 0 → time 1, never 00:00', async () => {
    const noDur = { ...FINGERPRINT, duration: 0 } as any;
    await uploadVideoMsgInfo({} as any, true, 12345, noDur);
    const info = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((info[0] as any).fileInfo.time).toBe(1);
  });

  it('[#145] real video dims are preserved on the main file even though the cover is the 720x1280 fallback', async () => {
    // FINGERPRINT has real 320x240 dims; the fast-upload cover is always the
    // 720x1280 fallback (no real cover cached on the forward path). The video
    // tile keeps the real dims — the cover/tile aspect mismatch is tolerated,
    // only a 0x0 MAIN file triggers 文件已过期.
    await uploadVideoMsgInfo({} as any, true, 12345, FINGERPRINT);
    const info = vi.mocked(pipeline.runNtv2Upload).mock.calls[0]![0].uploadInfo;
    expect((info[0] as any).fileInfo.width).toBe(320);   // main video: real dims preserved
    expect((info[0] as any).fileInfo.height).toBe(240);
    expect((info[1] as any).fileInfo.width).toBe(720);   // cover: fallback
    expect((info[1] as any).fileInfo.height).toBe(1280);
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

describe('video-upload — streaming path (real on-disk source)', () => {
  beforeEach(() => { vi.mocked(pipeline.runNtv2Upload).mockClear(); });

  it('stages + stream-hashes the source and PUTs via fileSource, never buffering bytes', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-vidstream-'));
    const file = path.join(dir, 'clip.mp4');
    const data = Buffer.alloc(3 * 1024 * 1024 + 77); // multi-1MiB-block + tail
    for (let i = 0; i < data.length; i++) data[i] = (i * 37 + 5) & 0xff;
    fs.writeFileSync(file, data);
    try {
      const bridge = { identity: { uin: '10001' } } as any;
      await uploadVideoMsgInfo(bridge, true, 12345, { type: 'video', url: pathToFileURL(file).href } as any);

      const args = vi.mocked(pipeline.runNtv2Upload).mock.calls.at(-1)![0];
      const main = args.uploads[0]!;
      // Main file streams from disk — fileSource set, no in-memory bytes.
      expect(main.fileSource).toBeDefined();
      expect(main.fileSource!.fileSize).toBe(data.length);
      expect(main.bytes.length).toBe(0);
      // The OIDB fileInfo carries the STREAMED hashes/size — must equal the
      // buffered hash of the same bytes (byte-identical guarantee end-to-end).
      const fi = (args.uploadInfo[0] as any).fileInfo;
      expect(fi.fileSize).toBe(data.length);
      expect(fi.fileHash).toBe(computeHashes(data).md5Hex);
      expect(fi.fileSha1).toBe(computeHashes(data).sha1Hex);
      // The staged temp is a copy/hardlink under the stage dir (NOT the source)
      // and is cleaned up after the send.
      expect(main.fileSource!.filePath).not.toBe(file);
      expect(fs.existsSync(main.fileSource!.filePath)).toBe(false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('cleans up the staged temp even when the upload throws', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-vidfail-'));
    const file = path.join(dir, 'clip.mp4');
    fs.writeFileSync(file, Buffer.alloc(2048, 7));
    try {
      vi.mocked(pipeline.runNtv2Upload).mockRejectedValueOnce(new Error('upload boom'));
      await expect(
        uploadVideoMsgInfo({ identity: { uin: '1' } } as any, true, 12345, { type: 'video', url: pathToFileURL(file).href } as any),
      ).rejects.toThrow(/upload boom/);
      // The staged temp created in loadVideo must be removed by the finally.
      const args = vi.mocked(pipeline.runNtv2Upload).mock.calls.at(-1)![0];
      const stagedPath = args.uploads[0]!.fileSource!.filePath;
      expect(fs.existsSync(stagedPath)).toBe(false);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });

  it('rejects an empty video source (0 bytes)', async () => {
    const dir = await fsp.mkdtemp(path.join(os.tmpdir(), 'sl-vidempty-'));
    const file = path.join(dir, 'empty.mp4');
    fs.writeFileSync(file, new Uint8Array(0));
    try {
      await expect(
        uploadVideoMsgInfo({ identity: { uin: '1' } } as any, true, 12345, { type: 'video', url: pathToFileURL(file).href } as any),
      ).rejects.toThrow(/empty/);
    } finally {
      await fsp.rm(dir, { recursive: true, force: true });
    }
  });
});
