import crypto from 'crypto';
import fs from 'fs';
import { promises as fsp } from 'fs';
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
import { stageSourceToDisk } from './stage';
import { hashFileStreaming } from './hash-file';
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

// Videos up to 1.5 GiB send through the Highway video path (matches the
// file-upload ceiling). Real-machine verified up to ~500 MB rendering and
// playing fine as a video; the old 100 MB cap existed only to dodge the
// width/height=0 → 已过期 bug (fixed above), not any real QQ size limit.
// Above this the OneBot layer re-routes to the file pipeline. NOTE: the
// whole video is buffered in RAM here (fs.readFileSync), so a 1.5 GiB send
// costs ~1.5 GiB+ of process memory.
export const MAX_VIDEO_SIZE = 1536 * 1024 * 1024;
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
  'iVBORw0KGgoAAAANSUhEUgAAAtAAAAUACAIAAADhrPJqAAAACXBIWXMAAAABAAAAAQBPJcTWAAAQAElEQVR4nO3WQQkAMAzAwOqYf6FVEQblTkGemQcAEJvfAQDAfYYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGgi6AggAABVxJREFUAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACBnOACAnOEAAHKGAwDIGQ4AIGc4AICc4QAAcoYDAMgZDgAgZzgAgJzhAAByhgMAyBkOACC3fMQgSD2JVRsAAAAASUVORK5CYII=',
  'base64',
);

// [#145] The fast-upload (fingerprint / forward) path has no video bytes to
// probe, so every field it ships is caller-supplied and untrusted — a video
// that arrived on the wire with no metadata caches 0s, and re-forwarding it
// with width/height=0 makes QQ-NT receivers render 文件已过期. FALLBACK_THUMB is
// a real 720x1280 cover; we derive the fallback video/cover dimensions FROM it
// so the declared video size, the declared cover size and the actual cover
// pixels are the same numbers by construction — never a 1x1 image lying about
// its size. Real cached dimensions always win over these.
const FALLBACK_THUMB_FORMAT = detectImageFormat(new Uint8Array(FALLBACK_THUMB));
const FAST_UPLOAD_FALLBACK_WIDTH = FALLBACK_THUMB_FORMAT.width || 720;
const FAST_UPLOAD_FALLBACK_HEIGHT = FALLBACK_THUMB_FORMAT.height || 1280;

interface VideoPayload {
  /** Main-file bytes. Empty on the normal path (streamed from `fileSource`)
   *  and when forwarding from cached fingerprints (fastOnly). */
  bytes: Uint8Array;
  /** Normal path: the staged video streams from this disk file instead of
   *  buffering `bytes`. Absent for the fingerprint fast path. */
  fileSource?: { filePath: string; fileSize: number };
  md5: Uint8Array;
  sha1: Uint8Array;
  sha1Blocks: Uint8Array[];
  md5Hex: string;
  sha1Hex: string;
  fileName: string;
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
  /** Baseline stat of the staged file captured before hashing; re-checked
   *  before the upload to fail cleanly if the source was mutated mid-send.
   *  Absent for the fingerprint fast path. */
  guard?: { size: number; mtimeMs: number };
  /** Release the staged temp (hardlink / download). Best-effort, idempotent. */
  cleanup: () => Promise<void>;
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
    // Declared cover dims == FALLBACK_THUMB's real pixels (same source as the
    // video fallback), so content and declared size always agree.
    width: FAST_UPLOAD_FALLBACK_WIDTH,
    height: FAST_UPLOAD_FALLBACK_HEIGHT,
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
    fileSize: element.fileSize ?? 0,
    // Zero-trust on the fast-upload path (no bytes to probe): `|| fallback` not
    // `??`, so a cached-but-zero value is replaced too. width/height=0 → the
    // receiver shows 文件已过期; duration=0 → every client renders 00:00 (#145).
    width: element.width || FAST_UPLOAD_FALLBACK_WIDTH,
    height: element.height || FAST_UPLOAD_FALLBACK_HEIGHT,
    duration: element.duration || 1,
    videoFormat: element.videoFormat ?? 0,
    thumb: makeFallbackThumb(),
    fastOnly: true,
    cleanup: async () => { /* nothing staged */ },
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

// ─────────────── thumb extraction ───────────────

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

  // The cover sub-file must declare its OWN pixel size, which can be smaller
  // than the video: the ffmpeg addon downscales large frames (4K/8K → ≤1080p)
  // so the JPEG cover stays under QQ's 1 MiB cover limit. Fall back to the video
  // dims when the format can't be read. For 1080p and custom-thumb sends the
  // cover already equals the video size, so this is a no-op there.
  const thumbWidth = fmt.width || width;
  const thumbHeight = fmt.height || height;

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
      width: thumbWidth,
      height: thumbHeight,
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

  const source = element.url || element.fileId || '';
  if (!source) throw new Error('video source is empty');

  // Stage onto a local disk path (hardlink / streamed download) and hash it in
  // one streaming pass — the video is never fully buffered in RAM. maxBytes =
  // MAX_VIDEO_SIZE; oversize sources throw here and the OneBot layer re-routes
  // them to the file pipeline (matches the message-actions size fallback).
  const staged = await stageSourceToDisk(source, MAX_VIDEO_SIZE);
  try {
    if (staged.fileSize === 0) throw new Error('video file is empty');

    // Baseline stat captured BEFORE hashing; re-checked before the upload so a
    // source mutated mid-send fails cleanly (see uploadVideoMsgInfo).
    const g = await fsp.stat(staged.filePath);
    const hashes = await hashFileStreaming(staged.filePath);
    const { thumb, width, height, duration } = await loadThumb(element, staged.filePath);

    return {
      bytes: new Uint8Array(0),
      fileSource: { filePath: staged.filePath, fileSize: staged.fileSize },
      md5: hashes.md5,
      sha1: hashes.sha1,
      sha1Blocks: hashes.sha1Blocks,
      md5Hex: hashes.md5Hex,
      sha1Hex: hashes.sha1Hex,
      fileName: (element.fileName || staged.fileName) || `${hashes.md5Hex}.mp4`,
      fileSize: staged.fileSize,
      width,
      height,
      duration,
      videoFormat: 0,
      thumb,
      fastOnly: false,
      guard: { size: g.size, mtimeMs: g.mtimeMs },
      cleanup: staged.cleanup,
    };
  } catch (err) {
    await staged.cleanup();
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
        fileSource: video.fileSource, // streamed from disk (undefined on the fingerprint fast path)
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

    // Mutation guard: the streaming path reads the staged file twice (hash pass
    // in loadVideo, then the highway PUT). For a hardlinked local source a
    // concurrent in-place write would make the uploaded bytes disagree with the
    // hashes we already sent. Re-stat before the PUT and fail cleanly if the
    // file changed since the baseline (the server's per-chunk md5 check is the
    // backstop during the PUT itself).
    if (video.guard && video.fileSource) {
      const now = await fsp.stat(video.fileSource.filePath);
      if (now.size !== video.guard.size || now.mtimeMs !== video.guard.mtimeMs) {
        throw new Error('video source changed during send (mutated between hashing and upload)');
      }
    }

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
            // [#145] Group video MUST carry real width/height. A real QQ
            // group video's MsgInfo has them (e.g. 296x640); sending 0x0
            // makes QQ-NT receivers (Android especially) fail to lay out
            // the video tile and render 文件已过期 even though the resource
            // is fresh and downloadable (iOS is lenient — shows expired but
            // still opens). c2c is left at 0 because the QQ-NT server has
            // been observed to reject non-zero dimensions there with a
            // schema-mismatch error (no c2c regression coverage yet).
            height: isGroup ? video.height : 0,
            width: isGroup ? video.width : 0,
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
    await video.cleanup();
  }
}
