import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { convertAudioBytes } from '@snowluma/protocol/highway/ffmpeg-addon';

interface NativeAudioAddon {
  convertToNTSilkTct(inputFile: string, outputFile: string): Promise<void>;
  decodeAudioToFmt(
    inputFile: string,
    outputFile: string,
    format: string,
  ): Promise<{ result: boolean; sampleRate: number; channels: number; format: string }>;
  getDuration(filePath: string): Promise<number>;
}

const __dirname = path.dirname(fileURLToPath(import.meta.url));

function makeMonoWav(sampleRate = 24_000, durationSeconds = 1): Buffer {
  const samples = sampleRate * durationSeconds;
  const bytes = Buffer.alloc(44 + samples * 2);
  bytes.write('RIFF', 0);
  bytes.writeUInt32LE(36 + samples * 2, 4);
  bytes.write('WAVE', 8);
  bytes.write('fmt ', 12);
  bytes.writeUInt32LE(16, 16);
  bytes.writeUInt16LE(1, 20);
  bytes.writeUInt16LE(1, 22);
  bytes.writeUInt32LE(sampleRate, 24);
  bytes.writeUInt32LE(sampleRate * 2, 28);
  bytes.writeUInt16LE(2, 32);
  bytes.writeUInt16LE(16, 34);
  bytes.write('data', 36);
  bytes.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) {
    bytes.writeInt16LE(Math.round(Math.sin(2 * Math.PI * 440 * i / sampleRate) * 12_000), 44 + i * 2);
  }
  return bytes;
}

function loadBundledAddon(): NativeAudioAddon {
  const addonPath = path.resolve(
    __dirname,
    `../../../runtime/native/ffmpeg/ffmpegAddon.${process.platform}.${process.arch}.node`,
  );
  const mod = { exports: {} as Record<string, unknown> };
  process.dlopen(mod, addonPath);
  return mod.exports as unknown as NativeAudioAddon;
}

function hasMp3Signature(bytes: Buffer): boolean {
  const hasId3Tag = bytes.length >= 3 && bytes.subarray(0, 3).toString('ascii') === 'ID3';
  const hasFrameSync = bytes.length >= 2 && bytes[0] === 0xff && (bytes[1] & 0xe0) === 0xe0;
  return hasId3Tag || hasFrameSync;
}

const isReleaseTarget = (process.platform === 'win32' && process.arch === 'x64')
  || (process.platform === 'linux' && (process.arch === 'x64' || process.arch === 'arm64'));
const describeBundledAddon = isReleaseTarget
  ? describe
  : describe.skip;

describeBundledAddon('bundled native ffmpeg addon', () => {
  let tmpDir: string;
  beforeAll(() => {
    tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sl-native-audio-test-'));
  });
  afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

  it('converts a mono QQ-style SILK record to a decodable MP3 through the public transcode seam', async () => {
    const addon = loadBundledAddon();
    const wavPath = path.join(tmpDir, 'mono-input.wav');
    const silkPath = path.join(tmpDir, 'mono-input.ntsilk');
    writeFileSync(wavPath, makeMonoWav());
    await addon.convertToNTSilkTct(wavPath, silkPath);

    const result = await convertAudioBytes(readFileSync(silkPath), 'mp3', { addon, tmpDir });
    const mp3 = Buffer.from(result.base64, 'base64');
    const outputPath = path.join(tmpDir, 'mono-output.mp3');
    writeFileSync(outputPath, mp3);

    expect(result.size).toBe(mp3.length);
    expect(hasMp3Signature(mp3)).toBe(true);
    const duration = await addon.getDuration(outputPath);
    expect(duration).toBeGreaterThan(0.9);
    expect(duration).toBeLessThan(1.2);
  });

  it('converts the QQ AI SILK container variant through the public transcode seam', async () => {
    const addon = loadBundledAddon();
    const wavPath = path.join(tmpDir, 'ai-input.wav');
    const silkPath = path.join(tmpDir, 'ai-input.ntsilk');
    writeFileSync(wavPath, makeMonoWav());
    await addon.convertToNTSilkTct(wavPath, silkPath);

    const aiSilk = readFileSync(silkPath);
    expect(aiSilk.subarray(0, 10)).toEqual(
      Buffer.concat([Buffer.from([0x02]), Buffer.from('#!SILK_V3', 'ascii')]),
    );
    aiSilk[0] = 0x03;

    const result = await convertAudioBytes(aiSilk, 'mp3', { addon, tmpDir });
    const mp3 = Buffer.from(result.base64, 'base64');
    const outputPath = path.join(tmpDir, 'ai-output.mp3');
    writeFileSync(outputPath, mp3);

    expect(hasMp3Signature(mp3)).toBe(true);
    const duration = await addon.getDuration(outputPath);
    expect(duration).toBeGreaterThan(0.9);
    expect(duration).toBeLessThan(1.2);
  });
});
