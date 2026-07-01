import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { createLogger } from '@snowluma/common/logger';
import type { BridgeContext } from '../bridge-context';
import type { MessageElement } from '../events';
import { getFFmpegAddon } from './ffmpeg-addon';
import {
  finalizeMediaMsgInfo,
  hexToBytes,
  runNtv2Upload,
  type MediaSubFileUpload,
} from './pipeline';
import {
  computeHashes,
  detectImageFormat,
  loadBinarySource,
  resolveLocalFilePath,
} from './utils';
import { Sha1Stream } from './sha1-stream';

const moduleLog = createLogger('Highway.Video');

function loggerFor(bridge: BridgeContext) {
  const raw = bridge.identity?.uin;
  const uin = typeof raw === 'string' ? Number.parseInt(raw, 10) : 0;
  return Number.isFinite(uin) && uin > 0 ? moduleLog.child({ uin }) : moduleLog;
}

export const PRIVATE_VIDEO_CMD_ID = 1001;
export const PRIVATE_VIDEO_THUMB_CMD_ID = 1002;
export const GROUP_VIDEO_CMD_ID = 1005;
export const GROUP_VIDEO_THUMB_CMD_ID = 1006;

export const MAX_VIDEO_SIZE = 100 * 1024 * 1024;
const MAX_VIDEO_SIZE_HARD = 1536 * 1024 * 1024;
const SHA1_STREAM_BLOCK_SIZE = 1024 * 1024;
const SHA1_BLOCK_SIZE = 64;

export function getVideoSourceSize(element: MessageElement): number | null {
  if (element.fileSize && element.fileSize > 0) return element.fileSize;
  const source = element.url || element.fileId || '';
  if (!source) return null;
  const local = resolveLocalFilePath(source);
  if (local && fs.existsSync(local)) {
    return fs.statSync(local).size;
  }
  return null;
}

const FALLBACK_THUMB = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+/p9sAAAAASUVORK5CYII=',
  'base64',
);

interface VideoPayload {
  /** Video bytes. Empty when forwarding from cached fingerprints. */
  bytes: Uint8Array;
  md5: Uint8Array;
  sha1: Uint8Array;
  sha1Blocks: Uint8Array[];
  md5Hex: string;
  sha1Hex: string;
  fileName: string;
  filePath: string;
  fileSize: number;
  width: number;
  height: number;
  duration: number;
  videoFormat: number;
  thumb: ThumbPayload;
  /** When true, video bytes are empty; pipeline throws fastOnlyError
   *  for the main file if the server demands the bytes. The thumb is
   *  always present (FALLBACK_THUMB at worst) so its sub-file uploads
   *  normally regardless. */
  fastOnly: boolean;
  cleanups: Array<() => void>;
}

function makeFallbackThumb(): ThumbPayload {
  const bytes = new Uint8Array(FALLBACK_THUMB);
  const hashes = computeHashes(bytes);
  return {
    bytes,
    md5: hashes.md5,
    sha1: hashes.sha1,
    md5Hex: hashes.md5Hex,
    sha1Hex: hashes.sha1Hex,
    width: 1,
    height: 1,
  };
}

function videoPayloadFromFingerprint(element: MessageElement): VideoPayload {
  return {
    bytes: new Uint8Array(0),
    md5: hexToBytes(element.md5Hex ?? ''),
    sha1: hexToBytes(element.sha1Hex ?? ''),
    sha1Blocks: [],
    md5Hex: element.md5Hex ?? '',
    sha1Hex: element.sha1Hex ?? '',
    fileName: element.fileName || `${element.md5Hex ?? 'video'}.mp4`,
    filePath: '',
    fileSize: element.fileSize ?? 0,
    width: element.width ?? 0,
    height: element.height ?? 0,
    duration: element.duration ?? 1,
    videoFormat: element.videoFormat ?? 0,
    thumb: makeFallbackThumb(),
    fastOnly: true,
    cleanups: [],
  };
}

interface ThumbPayload {
  bytes: Uint8Array;
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
  width: number;
  height: number;
}

// ─────────────── 1MB-block sha1 (Highway main-video extend) ───────────────

// Highway expects the sha1 of each 1 MB block (intermediate un-finalized state,
// little-endian) plus the overall sha1. Reuses the well-tested streaming
// Sha1Stream for the block states and Node crypto for the overall digest (same
// split as computeSha1StateV), replacing a ~110-line hand-rolled, untested
// SHA1 duplicate.
export function computeVideoSha1Blocks(bytes: Uint8Array): Uint8Array[] {
  const sha1 = new Sha1Stream();
  const blocks: Uint8Array[] = [];
  let bytesRead = 0;
  let offset = 0;
  while (offset + SHA1_BLOCK_SIZE <= bytes.length) {
    sha1.update(bytes.subarray(offset, offset + SHA1_BLOCK_SIZE));
    offset += SHA1_BLOCK_SIZE;
    bytesRead += SHA1_BLOCK_SIZE;
    if (bytesRead % SHA1_STREAM_BLOCK_SIZE === 0) {
      blocks.push(sha1.hash(true)); // little-endian intermediate state
    }
  }
  // Overall SHA1 (finalized) via Node crypto — the reference impl.
  blocks.push(new Uint8Array(crypto.createHash('sha1').update(Buffer.from(bytes)).digest()));
  return blocks;
}

// ─────────────── source staging + thumb extraction ───────────────

function defaultVideoTempDir(): string {
  return path.join(os.tmpdir(), 'snowluma-video');
}

function sourceExtension(fileName: string, source: string): string {
  const fromName = path.extname(fileName);
  if (fromName) return fromName;

  const local = resolveLocalFilePath(source);
  const fromSource = local ? path.extname(local) : '';
  return fromSource || '.mp4';
}

async function stageVideoSource(element: MessageElement, tempDir: string, cleanups: Array<() => void>): Promise<{
  bytes: Uint8Array;
  filePath: string;
  fileName: string;
}> {
  const source = element.url || element.fileId || '';
  if (!source) throw new Error('video source is empty');

  const local = resolveLocalFilePath(source);
  if (local && fs.existsSync(local)) {
    const stat = fs.statSync(local);
    if (stat.size > MAX_VIDEO_SIZE_HARD) {
      throw new Error(`video file too large: ${(stat.size / (1024 * 1024)).toFixed(2)} MB > ${MAX_VIDEO_SIZE_HARD / (1024 * 1024)} MB`);
    }
    if (stat.size > MAX_VIDEO_SIZE) {
      moduleLog.warn('video exceeds 100 MB (%d MB), trying Highway upload', stat.size / (1024 * 1024));
    }
    return {
      bytes: new Uint8Array(fs.readFileSync(local)),
      filePath: local,
      fileName: element.fileName || path.basename(local),
    };
  }

  const loaded = await loadBinarySource(source, 'video', MAX_VIDEO_SIZE_HARD);
  const fileName = element.fileName || loaded.fileName || '';
  const stagedPath = path.join(tempDir, `snowluma-video-in-${crypto.randomUUID()}${sourceExtension(fileName, source)}`);
  fs.writeFileSync(stagedPath, Buffer.from(loaded.bytes));
  cleanups.push(() => { try { fs.unlinkSync(stagedPath); } catch { /* ignore */ } });

  return {
    bytes: loaded.bytes,
    filePath: stagedPath,
    fileName,
  };
}

async function loadThumb(element: MessageElement, videoPath: string): Promise<{
  thumb: ThumbPayload;
  width: number;
  height: number;
  duration: number;
}> {
  let width = element.width ?? 0;
  let height = element.height ?? 0;
  let duration = element.duration ?? 0;
  let thumbBytes: Uint8Array | null = null;

  if (element.thumbUrl) {
    try {
      thumbBytes = (await loadBinarySource(element.thumbUrl, 'video thumbnail')).bytes;
    } catch (err) {
      moduleLog.warn('custom video thumbnail load failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  if (!thumbBytes) {
    try {
      const info = await getFFmpegAddon().getVideoInfo(videoPath);
      width = width || info.width || 0;
      height = height || info.height || 0;
      duration = duration || Math.max(1, Math.round(info.duration || 0));
      if (info.image && info.image.length > 0) {
        thumbBytes = new Uint8Array(info.image);
      }
    } catch (err) {
      moduleLog.warn('video thumbnail generation failed: %s', err instanceof Error ? err.message : String(err));
    }
  }

  if (!thumbBytes) {
    thumbBytes = new Uint8Array(FALLBACK_THUMB);
  }

  const fmt = detectImageFormat(thumbBytes);
  width = width || fmt.width || 1;
  height = height || fmt.height || 1;
  duration = duration || 1;

  const hashes = computeHashes(thumbBytes);
  return {
    width,
    height,
    duration,
    thumb: {
      bytes: thumbBytes,
      md5: hashes.md5,
      sha1: hashes.sha1,
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      width,
      height,
    },
  };
}

async function loadVideo(element: MessageElement): Promise<VideoPayload> {
  if (element.noByteFallback) {
    if (!element.md5Hex || !element.sha1Hex) {
      throw new Error('video fast-upload requires md5Hex + sha1Hex');
    }
    return videoPayloadFromFingerprint(element);
  }

  const tempDir = defaultVideoTempDir();
  const cleanups: Array<() => void> = [];
  fs.mkdirSync(tempDir, { recursive: true });

  try {
    const staged = await stageVideoSource(element, tempDir, cleanups);
    if (staged.bytes.length === 0) throw new Error('video file is empty');
    if (staged.bytes.length > MAX_VIDEO_SIZE_HARD) {
      throw new Error(`video file too large: ${(staged.bytes.length / (1024 * 1024)).toFixed(2)} MB > ${MAX_VIDEO_SIZE_HARD / (1024 * 1024)} MB`);
    }
    if (staged.bytes.length > MAX_VIDEO_SIZE) {
      moduleLog.warn('video bytes exceed 100 MB (%d MB), Highway upload may fail', staged.bytes.length / (1024 * 1024));
    }

    const hashes = computeHashes(staged.bytes);
    const { thumb, width, height, duration } = await loadThumb(element, staged.filePath);

    return {
      bytes: staged.bytes,
      md5: hashes.md5,
      sha1: hashes.sha1,
      sha1Blocks: computeVideoSha1Blocks(staged.bytes),
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      fileName: staged.fileName || `${hashes.md5Hex}.mp4`,
      filePath: staged.filePath,
      fileSize: staged.bytes.length,
      width,
      height,
      duration,
      videoFormat: 0,
      thumb,
      fastOnly: false,
      cleanups: [...cleanups],
    };
  } catch (err) {
    for (const fn of cleanups.reverse()) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
    throw err;
  }
}

// ─────────────── exported entry ───────────────

/**
 * Upload a video and return the encoded MsgInfo bytes that go inside a
 * `commonElem { serviceType: 48, businessType: 21 }`.
 *
 * Two highway PUTs run when the server doesn't fast-path: the main video
 * (with per-1MB-block sha1) and a thumb (read off `upload.subFileInfos[0]`).
 */
export async function uploadVideoMsgInfo(
  bridge: BridgeContext,
  isGroup: boolean,
  targetIdOrUid: string | number,
  element: MessageElement,
): Promise<Uint8Array> {
  const log = loggerFor(bridge);
  const video = await loadVideo(element);
  log.debug('uploading %d bytes md5=%s... → %s %s',
    video.fileSize,
    video.md5Hex.slice(0, 8),
    isGroup ? 'group' : 'c2c',
    String(targetIdOrUid));
  try {
    const uploads: MediaSubFileUpload[] = [
      {
        source: 'top',
        cmdId: isGroup ? GROUP_VIDEO_CMD_ID : PRIVATE_VIDEO_CMD_ID,
        bytes: video.bytes,
        md5: video.md5,
        sha1: video.sha1Blocks,
        subFileIndex: 0,
        fastOnlyError: 'video fast-upload not available (server requires bytes)',
      },
      {
        source: 0, // upload.subFileInfos[0]
        cmdId: isGroup ? GROUP_VIDEO_THUMB_CMD_ID : PRIVATE_VIDEO_THUMB_CMD_ID,
        bytes: video.thumb.bytes,
        md5: video.thumb.md5,
        sha1: video.thumb.sha1,
        subFileIndex: 1,
        // No fastOnlyError: thumb always has bytes (FALLBACK_THUMB at worst).
      },
    ];

    const upload = await runNtv2Upload({
      bridge,
      isGroup,
      targetIdOrUid,
      oidbCmd: isGroup ? 0x11EA : 0x11E9,
      serviceCmd: isGroup ? 'OidbSvcTrpcTcp.0x11ea_100' : 'OidbSvcTrpcTcp.0x11e9_100',
      requestId: 3,
      businessType: 2,
      uploadInfo: [
        {
          fileInfo: {
            fileSize: video.fileSize,
            fileHash: video.md5Hex,
            fileSha1: video.sha1Hex,
            fileName: 'nya.mp4',
            type: { type: 2, picFormat: 0, videoFormat: 0, voiceFormat: 0 },
            // Width/height kept at 0 — NapCat does the same and the QQ-NT
            // server has been observed to reject non-zero dimensions
            // here on c2c sends with a schema-mismatch error. acidify
            // *does* fill them (`payload.videoWidth/Height`) but we
            // leave that alone until c2c regression coverage exists.
            height: 0,
            width: 0,
            // `time` MUST be the real duration in seconds, otherwise
            // every receiving client renders "00:00" on the video.
            // NapCat ships `time: 0` because it sits on top of QQ-NT's
            // IPC layer, which the desktop client patches up before
            // the wire message goes out. We're a protocol-direct
            // client (same position as acidify), so we own this field.
            // acidify writes `payload.videoDuration` here for the same
            // reason — verified against `RichMediaUpload.kt::
            // buildVideoUploadInfoList` (2026-04 refactor).
            time: video.duration,
            original: 0,
          },
          subFileType: 0,
        },
        {
          fileInfo: {
            fileSize: video.thumb.bytes.length,
            fileHash: video.thumb.md5Hex,
            fileSha1: video.thumb.sha1Hex,
            fileName: 'nya.jpg',
            type: { type: 1, picFormat: 0, videoFormat: 0, voiceFormat: 0 },
            height: video.thumb.height,
            width: video.thumb.width,
            time: 0,
            original: 0,
          },
          subFileType: 100,
        },
      ],
      // Hardcoded 2 even on c2c (matches NapCat). Image/PTT use
      // `isGroup ? 2 : 1` because their legacy compat elements differ
      // per scene (notOnlineImage vs customFace; ptt c2c vs group),
      // but the legacy `videoFile` element has no scene split — its
      // fromChatType/toChatType live inside the element itself — so
      // the server generates a single group-shaped compat payload
      // regardless. Setting 1 here makes the server emit a c2c-scene
      // shaped compat blob that old QQ clients fail to resolve,
      // showing the message as "视频已过期" on those receivers while
      // new clients (which only read the commonElem) display fine.
      compatQmsgSceneType: 2,
      extBizInfo: {
        pic: { bizType: 0, textSummary: 'Nya~' },
        video: { bytesPbReserve: new Uint8Array([0x80, 0x01, 0x00]) },
        ptt: {
          bytesPbReserve: new Uint8Array(0),
          bytesReserve: new Uint8Array(0),
          bytesGeneralFlags: new Uint8Array(0),
        },
      },
      uploads,
      label: 'video',
    });

    log.debug('video upload completed: md5=%s scene=%s', video.md5Hex, isGroup ? 'group' : 'c2c');
    return finalizeMediaMsgInfo(upload);
  } finally {
    for (const fn of video.cleanups) {
      try { fn(); } catch { /* best-effort cleanup */ }
    }
  }
}
