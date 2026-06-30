import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

export interface FFmpegVideoInfo {
  width: number;
  height: number;
  duration: number;
  format: string;
  videoCodec: string;
  image: Buffer;
}

interface FFmpegNativeAddon {
  convertFile(inputFile: string, outputFile: string, format: string): Promise<{ success: boolean }>;
  getVideoInfo(filePath: string, format?: 'bmp' | 'bmp24'): Promise<FFmpegVideoInfo>;
  getDuration(filePath: string): Promise<number>;
  convertToNTSilkTct(inputPath: string, outputPath: string): Promise<void>;
  decodeAudioToPCM(filePath: string, pcmPath: string, sampleRate?: number): Promise<{ result: boolean; sampleRate: number }>;
  decodeAudioToFmt(filePath: string, pcmPath: string, format: string): Promise<{ channels: number; sampleRate: number; format: string }>;
}

let cachedAddon: FFmpegNativeAddon | null = null;
let cachedLoadError: string | null = null;

function addonFileName(): string {
  return `ffmpegAddon.${process.platform}.${process.arch}.node`;
}

function addonSearchDirs(): string[] {
  // Mirrors the hook injector's resolution strategy so the addon is found
  // regardless of whether we're running from:
  //   1. A released zip (dist/native/ffmpeg/<file>.node), where __dirname is
  //      the dist root.
  //   2. The bundled build (repoRoot/dist/native/ffmpeg/<file>.node).
  //   3. `tsx` dev mode (packages/runtime/native/ffmpeg/<file>.node), where
  //      __dirname is `packages/core/src/bridge/highway` — four levels deep
  //      under `packages/`. Note: the hook injector lives at
  //      `packages/core/src/hook` so it only needs 3 `..`; we need 4.
  return [
    path.resolve(__dirname, 'native', 'ffmpeg'),
    path.resolve(__dirname, '..', '..', '..', '..', 'runtime', 'native', 'ffmpeg'),
    path.resolve(process.cwd(), 'dist', 'native', 'ffmpeg'),
    path.resolve(process.cwd(), 'packages', 'runtime', 'native', 'ffmpeg'),
  ];
}

function resolveAddonPath(): string | null {
  const fileName = addonFileName();
  for (const dir of addonSearchDirs()) {
    const full = path.join(dir, fileName);
    if (fs.existsSync(full)) return full;
  }
  return null;
}

/**
 * Load the ffmpegAddon once and return a cached instance.
 * Throws on first-use failure; subsequent calls replay the same error message
 * so callers don't silently fall back.
 */
export function getFFmpegAddon(): FFmpegNativeAddon {
  if (cachedAddon) return cachedAddon;
  if (cachedLoadError) throw new Error(cachedLoadError);

  const addonPath = resolveAddonPath();
  if (!addonPath) {
    cachedLoadError = `ffmpegAddon not found for ${process.platform}-${process.arch} (looked for ${addonFileName()})`;
    throw new Error(cachedLoadError);
  }

  try {
    const mod = { exports: {} as Record<string, unknown> };
    process.dlopen(mod, addonPath);
    cachedAddon = mod.exports as unknown as FFmpegNativeAddon;
    return cachedAddon;
  } catch (error) {
    cachedLoadError = `failed to load ffmpegAddon (${addonPath}): ${error instanceof Error ? error.message : String(error)}`;
    throw new Error(cachedLoadError);
  }
}

/**
 * Check whether `filePath` is already an NT SILK container. The addon can
 * read any input directly so the only reason we peek at the header is to
 * skip the conversion (and the temp file) when the caller already fed us
 * a ready-to-upload silk file.
 */
export function isSilkFile(filePath: string): boolean {
  try {
    const fd = fs.openSync(filePath, 'r');
    try {
      const buf = Buffer.alloc(10);
      fs.readSync(fd, buf, 0, 10, 0);
      const header = buf.toString();
      return header.includes('#!SILK') || header.includes('\x02#!SILK');
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return false;
  }
}

export interface EncodeSilkResult {
  /** Absolute path to the silk file ready for highway upload. */
  path: string;
  /** Voice duration in whole seconds (>= 1). */
  duration: number;
  /** `true` if we wrote a new silk file and the caller should unlink it. */
  converted: boolean;
}

/**
 * Convert `inputFile` to NT SILK when necessary and return the output path
 * + duration. The caller is responsible for unlinking the returned path
 * when `converted === true`.
 */
export async function encodeSilk(inputFile: string, tempDir: string): Promise<EncodeSilkResult> {
  const addon = getFFmpegAddon();

  // Already silk — trust the file, just measure duration via the addon.
  if (isSilkFile(inputFile)) {
    let duration = 1;
    try {
      duration = Math.max(1, Math.round(await addon.getDuration(inputFile)));
    } catch {
      // getDuration on a silk file occasionally fails on certain encodings;
      // the upload path only needs a rough, non-zero value, so fall back
      // to the size-based heuristic used by NapCat's audio.ts.
      const stat = fs.statSync(inputFile);
      duration = Math.max(1, Math.floor(stat.size / 1024 / 3));
    }
    return { path: inputFile, duration, converted: false };
  }

  fs.mkdirSync(tempDir, { recursive: true });
  const outPath = path.join(tempDir, crypto.randomUUID());
  await addon.convertToNTSilkTct(inputFile, outPath);
  if (!fs.existsSync(outPath)) {
    throw new Error('convertToNTSilkTct produced no output file');
  }
  const duration = Math.max(1, Math.round(await addon.getDuration(inputFile)));
  return { path: outPath, duration, converted: true };
}

/** Default location for temporary silk files. */
export function defaultPttTempDir(): string {
  return path.join(os.tmpdir(), 'snowluma-ptt');
}

// ── audio transcode (get_record out_format, #165) ──
// The addon is a custom ffmpeg build that bundles a SILK decoder, so it can
// transcode a QQ voice (SILK/AMR) into a normal container in one convertFile
// call — mirroring NapCat's FFmpegService.convertAudioFmt.

/** Output formats accepted by `out_format` (mirrors NapCat's allowlist). */
export const AUDIO_OUT_FORMATS = ['mp3', 'amr', 'wma', 'm4a', 'spx', 'ogg', 'wav', 'flac'] as const;
export type AudioOutFormat = (typeof AUDIO_OUT_FORMATS)[number];
export function isAudioOutFormat(s: string): s is AudioOutFormat {
  return (AUDIO_OUT_FORMATS as readonly string[]).includes(s);
}

/** Minimal addon surface the transcode needs — lets tests inject a fake. */
type AudioConvertAddon = Pick<FFmpegNativeAddon, 'convertFile'>;

/** Default ceiling on the transcoded output read into memory for base64. SILK→
 *  WAV/FLAC is a decompressing direction, so cap it even though real voices are
 *  tiny. Generous; overridable via deps. */
const DEFAULT_MAX_AUDIO_OUTPUT = 256 * 1024 * 1024; // 256 MiB

/**
 * Transcode raw audio bytes (a QQ voice SILK/AMR) to `format`, returning the
 * result as base64 + byte size. Writes the input + output to temp files (the
 * native addon is file-based), always cleaning them up. `deps` injects a fake
 * addon / tmp dir for tests. Throws on an unsupported format or a failed
 * conversion (e.g. the binary lacks SILK decode).
 */
export async function convertAudioBytes(
  bytes: Uint8Array,
  format: string,
  deps: { addon?: AudioConvertAddon; tmpDir?: string; maxOutputBytes?: number } = {},
): Promise<{ base64: string; size: number }> {
  if (!isAudioOutFormat(format)) {
    throw new Error(`unsupported out_format: ${format} (expected one of ${AUDIO_OUT_FORMATS.join(', ')})`);
  }
  const addon = deps.addon ?? getFFmpegAddon();
  const maxOut = deps.maxOutputBytes ?? DEFAULT_MAX_AUDIO_OUTPUT;
  const dir = deps.tmpDir ?? path.join(os.tmpdir(), 'snowluma-rec');
  fs.mkdirSync(dir, { recursive: true });
  const id = crypto.randomBytes(8).toString('hex');
  const inPath = path.join(dir, `${id}.in`);
  const outPath = path.join(dir, `${id}.${format}`);
  try {
    await fs.promises.writeFile(inPath, bytes);
    const res = await addon.convertFile(inPath, outPath, format);
    if (!res?.success || !fs.existsSync(outPath)) throw new Error('audio conversion failed');
    // Bound the output before reading it into memory (decompressing direction).
    const stat = await fs.promises.stat(outPath);
    if (stat.size > maxOut) throw new Error(`converted audio too large: ${stat.size} > ${maxOut}`);
    const out = await fs.promises.readFile(outPath);
    return { base64: out.toString('base64'), size: out.length };
  } finally {
    // Await cleanup so no temp file lingers past the call (the bytes are
    // already in memory by now). allSettled → a missing file never throws.
    await Promise.allSettled([
      fs.promises.rm(inPath, { force: true }),
      fs.promises.rm(outPath, { force: true }),
    ]);
  }
}
