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

// Highway expects sha1 computed over each 1 MB block of the file, plus
// the final overall sha1. This is a streaming implementation that doesn't
// reuse Node's crypto because Node only exposes the final digest.

class Sha1StreamState {
  readonly blockSize = 64;
  private readonly padding = Buffer.concat([Buffer.from([0x80]), Buffer.alloc(63)]);
  private readonly state = new Uint32Array(5);
  private readonly count = new Uint32Array(2);
  private readonly buffer = Buffer.allocUnsafe(this.blockSize);
  private readonly w = new Uint32Array(80);

  constructor() {
    this.reset();
  }

  private reset(): void {
    this.state[0] = 0x67452301;
    this.state[1] = 0xEFCDAB89;
    this.state[2] = 0x98BADCFE;
    this.state[3] = 0x10325476;
    this.state[4] = 0xC3D2E1F0;
    this.count[0] = 0;
    this.count[1] = 0;
    this.buffer.fill(0);
  }

  private rotateLeft(value: number, offset: number): number {
    return ((value << offset) | (value >>> (32 - offset))) >>> 0;
  }

  private transform(chunk: Uint8Array, offset: number): void {
    const view = new DataView(chunk.buffer, chunk.byteOffset + offset, this.blockSize);

    for (let i = 0; i < 16; i++) {
      this.w[i] = view.getUint32(i * 4, false);
    }
    for (let i = 16; i < 80; i++) {
      this.w[i] = this.rotateLeft(this.w[i - 3] ^ this.w[i - 8] ^ this.w[i - 14] ^ this.w[i - 16], 1);
    }

    let a = this.state[0];
    let b = this.state[1];
    let c = this.state[2];
    let d = this.state[3];
    let e = this.state[4];

    for (let i = 0; i < 80; i++) {
      let temp: number;
      if (i < 20) {
        temp = ((b & c) | (~b & d)) + 0x5A827999;
      } else if (i < 40) {
        temp = (b ^ c ^ d) + 0x6ED9EBA1;
      } else if (i < 60) {
        temp = ((b & c) | (b & d) | (c & d)) + 0x8F1BBCDC;
      } else {
        temp = (b ^ c ^ d) + 0xCA62C1D6;
      }
      temp += (this.rotateLeft(a, 5) + e + this.w[i]) >>> 0;
      e = d;
      d = c;
      c = this.rotateLeft(b, 30);
      b = a;
      a = temp >>> 0;
    }

    this.state[0] = (this.state[0] + a) >>> 0;
    this.state[1] = (this.state[1] + b) >>> 0;
    this.state[2] = (this.state[2] + c) >>> 0;
    this.state[3] = (this.state[3] + d) >>> 0;
    this.state[4] = (this.state[4] + e) >>> 0;
  }

  update(data: Uint8Array): void {
    let index = (this.count[0] >>> 3) & 0x3F;
    const dataLen = data.length;
    this.count[0] = (this.count[0] + (dataLen << 3)) >>> 0;
    if (this.count[0] < (dataLen << 3)) this.count[1] = (this.count[1] + 1) >>> 0;
    this.count[1] = (this.count[1] + (dataLen >>> 29)) >>> 0;

    const partLen = this.blockSize - index;
    let i = 0;

    if (dataLen >= partLen) {
      this.buffer.set(data.subarray(0, partLen), index);
      this.transform(this.buffer, 0);
      for (i = partLen; i + this.blockSize <= dataLen; i += this.blockSize) {
        this.transform(data, i);
      }
      index = 0;
    }

    if (i < dataLen) {
      this.buffer.set(data.subarray(i, dataLen), index);
    }
  }

  hash(bigEndian = true): Uint8Array {
    const digest = Buffer.allocUnsafe(20);
    for (let i = 0; i < 5; i++) {
      if (bigEndian) digest.writeUInt32BE(this.state[i], i * 4);
      else digest.writeUInt32LE(this.state[i], i * 4);
    }
    return new Uint8Array(digest);
  }

  final(): Uint8Array {
    const bits = Buffer.allocUnsafe(8);
    bits.writeUInt32BE(this.count[1], 0);
    bits.writeUInt32BE(this.count[0], 4);

    const index = (this.count[0] >>> 3) & 0x3F;
    const padLen = index < 56 ? 56 - index : 120 - index;
    this.update(this.padding.subarray(0, padLen));
    this.update(bits);
    return this.hash(true);
  }
}

function computeVideoSha1Blocks(bytes: Uint8Array): Uint8Array[] {
  const sha1 = new Sha1StreamState();
  const blocks: Uint8Array[] = [];
  let bytesRead = 0;
  let offset = 0;

  while (offset + sha1.blockSize <= bytes.length) {
    const block = bytes.subarray(offset, offset + sha1.blockSize);
    sha1.update(block);
    offset += sha1.blockSize;
    bytesRead += sha1.blockSize;
    if (bytesRead % SHA1_STREAM_BLOCK_SIZE === 0) {
      blocks.push(sha1.hash(false));
    }
  }

  if (offset < bytes.length) sha1.update(bytes.subarray(offset));
  blocks.push(sha1.final());
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
        // Distrust a server fast-path for the main video: group/c2c video
        // resources expire server-side, so reusing a cached object can show
        // "资源已过期" on the receiver even though the send "succeeded".
        // When we hold the real bytes, force a fresh full upload instead.
        // (Forwarding carries no bytes, so this never fires there.) See #145.
        forceFullOnFastPath: true,
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
