import { createHash } from 'crypto';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

export interface LoadedBinary {
  bytes: Uint8Array;
  fileName: string;
}

/**
 * Default cap on a single binary load issued through this helper. Callers
 * that route here (image / voice via base64+HTTP, group/private file
 * uploads, avatar) get bounded reads. Not all callers route through here
 * — in particular `video-upload.stageVideoSource` reads local-video files
 * directly and enforces its own cap via `MAX_VIDEO_SIZE`. Group/private
 * file uploads override this via `FILE_UPLOAD_MAX_BYTES` because QQ's
 * file protocol legitimately supports up to 4 GiB.
 */
const DEFAULT_MAX_BINARY_SIZE = 1024 * 1024 * 1024; // 1 GiB
/** Hard ceiling QQ's file protocol supports — used by group/private files. */
export const FILE_UPLOAD_MAX_BYTES = 4 * 1024 * 1024 * 1024; // 4 GiB
const FETCH_TIMEOUT_MS = 60_000;

/**
 * Browser-like User-Agent for remote media downloads. Many image / CDN
 * hosts (and anti-hotlink front-ends) reject or RST a header-less,
 * non-browser request — which surfaces as undici `TypeError: fetch
 * failed` rather than a clean 403. Sending a normal browser UA on every
 * request (and retrying with a Referer when the first try is refused) is
 * what lets NapCat fetch sources our bare `fetch(source)` couldn't.
 * Cross-checked against
 * `dev/napcatQQInside/packages/napcat-common/src/file.ts:101-142,359-369`.
 */
const DOWNLOAD_USER_AGENT =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

export interface ImageHashes {
  md5: Uint8Array;
  sha1: Uint8Array;
  md5Hex: string;
  sha1Hex: string;
}

export interface ImageFormat {
  format: number; // 1000=jpg, 1001=png, 1002=webp, 1005=bmp, 2000=gif
  width: number;
  height: number;
}

// --- Binary source loading ---

export function resolveLocalFilePath(source: string): string | null {
  if (!source) return null;
  if (/^base64:\/\//i.test(source)) return null;
  if (/^https?:\/\//i.test(source)) return null;

  let filePath = source;
  if (/^file:\/\//i.test(source)) {
    try {
      filePath = fileURLToPath(source);
    } catch {
      filePath = source.replace(/^file:\/+/i, '/');
      try {
        filePath = decodeURIComponent(filePath);
      } catch {
        // Keep the original fallback path when percent decoding fails.
      }
    }

    if (process.platform !== 'win32' && filePath.startsWith('//')) {
      filePath = filePath.replace(/^\/+/, '/');
    }
  }

  // Windows-style paths can arrive from file:///C:/... as /C:/...
  if (/^\/[a-zA-Z]:/.test(filePath)) filePath = filePath.slice(1);
  return filePath;
}

/**
 * Tag a size-limit error so the HTTP retry path leaves it alone — retrying
 * a too-large response just re-downloads the same oversized body.
 */
function tooLarge(message: string): Error {
  return Object.assign(new Error(message), { noRetry: true });
}

export async function loadBinarySource(
  source: string,
  resourceName: string,
  maxBytes: number = DEFAULT_MAX_BINARY_SIZE,
): Promise<LoadedBinary> {
  if (!source) throw new Error(`${resourceName} source is empty`);

  if (/^base64:\/\//i.test(source)) {
    const bytes = Buffer.from(source.slice(9), 'base64');
    if (bytes.length > maxBytes) {
      throw new Error(`${resourceName} too large: ${bytes.length} > ${maxBytes}`);
    }
    return { bytes, fileName: '' };
  }

  if (/^https?:\/\//i.test(source)) {
    const fileName = guessFileNameFromUrl(source);

    // A single fetch attempt with the given headers. Streams the body
    // incrementally so a server that omits or understates Content-Length
    // can't make us buffer a chunked response past maxBytes — `await
    // resp.arrayBuffer()` would happily allocate the entire payload before
    // we get a chance to length-check it. Size-limit rejections are tagged
    // `noRetry` so the outer retry doesn't re-download an oversized body.
    const attempt = async (headers: Record<string, string>): Promise<LoadedBinary> => {
      const resp = await fetch(source, {
        headers,
        redirect: 'follow',
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      });
      if (!resp.ok) throw new Error(`HTTP download failed: ${resp.status}`);
      const declared = Number(resp.headers.get('content-length') ?? '0');
      if (Number.isFinite(declared) && declared > maxBytes) {
        throw tooLarge(`${resourceName} too large: ${declared} > ${maxBytes}`);
      }
      const reader = resp.body?.getReader();
      if (!reader) {
        const bytes = new Uint8Array(await resp.arrayBuffer());
        if (bytes.length > maxBytes) {
          throw tooLarge(`${resourceName} too large: ${bytes.length} > ${maxBytes}`);
        }
        return { bytes, fileName };
      }
      const chunks: Uint8Array[] = [];
      let total = 0;
      try {
        while (true) {
          const { done, value } = await reader.read();
          if (done) break;
          if (!value) continue;
          total += value.byteLength;
          if (total > maxBytes) {
            await reader.cancel().catch(() => { /* ignore */ });
            throw tooLarge(`${resourceName} too large: > ${maxBytes}`);
          }
          chunks.push(value);
        }
      } finally {
        reader.releaseLock();
      }
      const bytes = new Uint8Array(total);
      let offset = 0;
      for (const chunk of chunks) {
        bytes.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return { bytes, fileName };
    };

    // First try with a browser UA only. On any non-size failure — a
    // network-level `fetch failed` (connection reset by an anti-bot
    // front-end) or a 403/4xx from anti-hotlink — retry once with a
    // Referer pointing at the resource itself, the common bypass for
    // same-origin hotlink checks. Mirrors NapCat's with/without-Referer
    // strategy.
    const baseHeaders: Record<string, string> = {
      'User-Agent': DOWNLOAD_USER_AGENT,
      Accept: '*/*',
    };
    try {
      return await attempt(baseHeaders);
    } catch (err) {
      if ((err as { noRetry?: boolean } | null)?.noRetry) throw err;
      try {
        return await attempt({ ...baseHeaders, Referer: source });
      } catch {
        throw err;
      }
    }
  }

  const filePath = resolveLocalFilePath(source);
  if (!filePath) throw new Error(`${resourceName} source is not a local file`);

  const stat = fs.statSync(filePath);
  if (stat.size > maxBytes) {
    throw new Error(`${resourceName} too large: ${stat.size} > ${maxBytes}`);
  }
  const bytes = fs.readFileSync(filePath);
  const fileName = path.basename(filePath);
  return { bytes, fileName };
}

function guessFileNameFromUrl(url: string): string {
  const queryPos = url.search(/[?#]/);
  const pathPart = queryPos >= 0 ? url.slice(0, queryPos) : url;
  const lastSlash = pathPart.lastIndexOf('/');
  return lastSlash >= 0 ? pathPart.slice(lastSlash + 1) : '';
}

// --- Hashing ---

export function computeHashes(data: Uint8Array): ImageHashes {
  const md5 = createHash('md5').update(data).digest();
  const sha1 = createHash('sha1').update(data).digest();
  return {
    md5: new Uint8Array(md5),
    sha1: new Uint8Array(sha1),
    md5Hex: md5.toString('hex'),
    sha1Hex: sha1.toString('hex'),
  };
}

export function computeMd5(data: Uint8Array): Uint8Array {
  return new Uint8Array(createHash('md5').update(data).digest());
}

// --- Image format detection (port of C++ detect_image_format) ---

function readBE16(data: Uint8Array, offset: number): number {
  return (data[offset] << 8) | data[offset + 1];
}

function readBE32(data: Uint8Array, offset: number): number {
  return ((data[offset] << 24) | (data[offset + 1] << 16) | (data[offset + 2] << 8) | data[offset + 3]) >>> 0;
}

function readLE16(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8);
}

function readLE32(data: Uint8Array, offset: number): number {
  return (data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16) | (data[offset + 3] << 24)) >>> 0;
}

function readLE24(data: Uint8Array, offset: number): number {
  return data[offset] | (data[offset + 1] << 8) | (data[offset + 2] << 16);
}

export function detectImageFormat(bytes: Uint8Array): ImageFormat {
  let width = 0;
  let height = 0;

  // PNG
  if (bytes.length >= 24 &&
    bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4E && bytes[3] === 0x47) {
    width = readBE32(bytes, 16);
    height = readBE32(bytes, 20);
    return { format: 1001, width, height };
  }

  // GIF
  if (bytes.length >= 10 &&
    bytes[0] === 0x47 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) && bytes[5] === 0x61) {
    width = readLE16(bytes, 6);
    height = readLE16(bytes, 8);
    return { format: 2000, width, height };
  }

  // BMP
  if (bytes.length >= 26 && bytes[0] === 0x42 && bytes[1] === 0x4D) {
    width = readLE32(bytes, 18);
    height = readLE32(bytes, 22);
    return { format: 1005, width, height };
  }

  // WebP
  if (bytes.length >= 30 &&
    bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
    bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x20) {
      width = readLE16(bytes, 26);
      height = readLE16(bytes, 28);
      return { format: 1002, width, height };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x4C) {
      const bits = readLE32(bytes, 21);
      width = (bits & 0x3FFF) + 1;
      height = ((bits >> 14) & 0x3FFF) + 1;
      return { format: 1002, width, height };
    }
    if (bytes[12] === 0x56 && bytes[13] === 0x50 && bytes[14] === 0x38 && bytes[15] === 0x58) {
      // VP8X canvas width/height are 24-bit LITTLE-endian (Minus-One). Reading
      // them big-endian inflated dims to absurd values (e.g. 1920×1080 →
      // 8324865×3605505), cropping the QQ thumbnail. (issue #112)
      width = readLE24(bytes, 24) + 1;
      height = readLE24(bytes, 27) + 1;
      return { format: 1002, width, height };
    }
  }

  // JPEG
  if (bytes.length >= 4 && bytes[0] === 0xFF && bytes[1] === 0xD8) {
    let offset = 2;
    while (offset + 9 <= bytes.length) {
      if (bytes[offset] !== 0xFF) { offset++; continue; }
      const marker = bytes[offset + 1];
      if (marker === 0xD8 || marker === 0xD9) { offset += 2; continue; }
      if (offset + 4 > bytes.length) break;
      const segLen = readBE16(bytes, offset + 2);
      if (segLen < 2 || offset + 2 + segLen > bytes.length) break;
      // Real SOF markers: 0xC0..0xCF EXCEPT 0xC4 (DHT), 0xC8 (JPG), 0xCC
      // (DAC). The previous `(marker & 0xFC) === 0xC0` check accepted DHT
      // and friends, then misread Huffman table bytes as image dimensions.
      const isSof = marker >= 0xC0 && marker <= 0xCF
        && marker !== 0xC4 && marker !== 0xC8 && marker !== 0xCC;
      if (isSof && segLen >= 7 && offset + 9 <= bytes.length) {
        height = readBE16(bytes, offset + 5);
        width = readBE16(bytes, offset + 7);
        return { format: 1000, width, height };
      }
      offset += 2 + segLen;
    }
    return { format: 1000, width: 0, height: 0 };
  }

  return { format: 1000, width: 0, height: 0 };
}

// --- Highway frame packing/unpacking ---

export function packHighwayFrame(head: Uint8Array, body: Uint8Array): Uint8Array {
  const frame = new Uint8Array(9 + head.length + body.length + 1);
  frame[0] = 0x28;
  const dv = new DataView(frame.buffer, frame.byteOffset);
  dv.setUint32(1, head.length, false);
  dv.setUint32(5, body.length, false);
  frame.set(head, 9);
  frame.set(body, 9 + head.length);
  frame[frame.length - 1] = 0x29;
  return frame;
}

export function unpackHighwayFrame(frame: Uint8Array): { head: Uint8Array; body: Uint8Array } {
  if (frame.length < 10 || frame[0] !== 0x28 || frame[frame.length - 1] !== 0x29) {
    throw new Error('invalid highway response frame');
  }
  const dv = new DataView(frame.buffer, frame.byteOffset);
  const headLen = dv.getUint32(1, false);
  const bodyLen = dv.getUint32(5, false);
  return {
    head: frame.subarray(9, 9 + headLen),
    body: frame.subarray(9 + headLen, 9 + headLen + bodyLen),
  };
}
