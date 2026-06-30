import { afterAll, describe, expect, it } from 'vitest';
import { mkdtempSync, readdirSync, rmSync, writeFileSync } from 'fs';
import os from 'os';
import path from 'path';
import { AUDIO_OUT_FORMATS, convertAudioBytes, isAudioOutFormat } from '@snowluma/protocol/highway/ffmpeg-addon';

// convertAudioBytes is the pure (#165) transcode seam: write input → addon
// convertFile → read output as base64 → always clean up temp files. The native
// addon is file-based and can't run in CI, so a fake addon stands in.

const tmpDir = mkdtempSync(path.join(os.tmpdir(), 'sl-audio-test-'));
afterAll(() => rmSync(tmpDir, { recursive: true, force: true }));

/** Fake addon: writes deterministic bytes to the output path and reports ok. */
const fakeOk = {
  convertFile: async (_in: string, out: string, _fmt: string) => {
    writeFileSync(out, Buffer.from('WAVDATA')); // stand-in converted payload
    return { success: true };
  },
};

describe('isAudioOutFormat / AUDIO_OUT_FORMATS', () => {
  it('accepts exactly NapCat\'s allowlist', () => {
    expect([...AUDIO_OUT_FORMATS]).toEqual(['mp3', 'amr', 'wma', 'm4a', 'spx', 'ogg', 'wav', 'flac']);
    expect(isAudioOutFormat('wav')).toBe(true);
    expect(isAudioOutFormat('WAV')).toBe(false); // case-sensitive
    expect(isAudioOutFormat('opus')).toBe(false);
    expect(isAudioOutFormat('')).toBe(false);
  });
});

describe('convertAudioBytes', () => {
  it('transcodes and returns base64 + size of the addon output', async () => {
    const r = await convertAudioBytes(new Uint8Array([1, 2, 3]), 'wav', { addon: fakeOk, tmpDir });
    expect(Buffer.from(r.base64, 'base64').toString()).toBe('WAVDATA');
    expect(r.size).toBe('WAVDATA'.length);
  });

  it('rejects an unsupported format before touching the addon', async () => {
    let called = false;
    const spy = { convertFile: async () => { called = true; return { success: true }; } };
    await expect(convertAudioBytes(new Uint8Array([1]), 'opus', { addon: spy, tmpDir })).rejects.toThrow(/unsupported out_format/);
    expect(called).toBe(false);
  });

  it('throws and cleans up when the addon reports failure', async () => {
    const fakeFail = { convertFile: async () => ({ success: false }) };
    await expect(convertAudioBytes(new Uint8Array([9]), 'mp3', { addon: fakeFail, tmpDir })).rejects.toThrow(/conversion failed/);
    // no leftover temp files for this run
    const leftover = readdirSync(tmpDir).filter((n) => n.endsWith('.mp3') || n.endsWith('.in'));
    expect(leftover).toEqual([]);
  });

  it('rejects (and cleans up) when the output exceeds the cap', async () => {
    await expect(
      convertAudioBytes(new Uint8Array([1]), 'wav', { addon: fakeOk, tmpDir, maxOutputBytes: 3 }),
    ).rejects.toThrow(/too large/);
    const leftover = readdirSync(tmpDir).filter((n) => n.endsWith('.wav') || n.endsWith('.in'));
    expect(leftover).toEqual([]);
  });

  it('cleans up the temp input + output on success too', async () => {
    await convertAudioBytes(new Uint8Array([4, 5]), 'flac', { addon: fakeOk, tmpDir });
    const leftover = readdirSync(tmpDir).filter((n) => n.endsWith('.flac') || n.endsWith('.in'));
    expect(leftover).toEqual([]);
  });
});
