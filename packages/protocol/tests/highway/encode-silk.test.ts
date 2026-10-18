import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@snowluma/common/native-path', () => ({
    resolveRuntimeNativePath: () => '/test/ffmpeg.node',
}));

const addon = {
    getDuration: vi.fn<(file: string) => Promise<number>>(),
    convertToNTSilkTct: vi.fn<(input: string, output: string) => Promise<void>>(),
};
let root: string;

beforeEach(() => {
    vi.resetModules();
    addon.getDuration.mockReset().mockResolvedValue(2.5);
    addon.convertToNTSilkTct.mockReset().mockImplementation(async (_input, output) => {
        await fs.promises.writeFile(output, '\x02#!SILK_V3payload');
    });
    vi.spyOn(process, 'dlopen').mockImplementation((module) => {
        (module as { exports: object }).exports = addon;
    });
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-encode-silk-'));
});

afterEach(() => {
    vi.restoreAllMocks();
    fs.rmSync(root, { recursive: true, force: true });
});

describe('SILK encoding', () => {
    it('rejects unreadable files instead of treating them as a different audio format', async () => {
        const { isSilkFile } = await import('../../src/highway/ffmpeg-addon');
        expect(() => isSilkFile(path.join(root, 'missing'))).toThrow(/ENOENT/);
    });

    it('keeps native duration failures visible instead of guessing from SILK file size', async () => {
        const input = path.join(root, 'invalid.silk');
        fs.writeFileSync(input, '#!SILK_V3truncated');
        const failure = new Error('truncated SILK packet');
        addon.getDuration.mockRejectedValue(failure);
        const { encodeSilk } = await import('../../src/highway/ffmpeg-addon');
        await expect(encodeSilk(input, root)).rejects.toBe(failure);
        expect(addon.convertToNTSilkTct).not.toHaveBeenCalled();
        expect(fs.readdirSync(root)).toEqual(['invalid.silk']);
    });

    it('reuses a valid SILK input without creating a temporary file', async () => {
        const input = path.join(root, 'voice.silk');
        fs.writeFileSync(input, '\x02#!SILK_V3payload');
        const { encodeSilk } = await import('../../src/highway/ffmpeg-addon');
        await expect(encodeSilk(input, root)).resolves.toEqual({
            path: input,
            duration: 3,
            converted: false,
        });
        expect(addon.convertToNTSilkTct).not.toHaveBeenCalled();
    });

    it('returns the converted file for caller-owned cleanup', async () => {
        const input = path.join(root, 'voice.wav');
        fs.writeFileSync(input, 'RIFF');
        const { encodeSilk } = await import('../../src/highway/ffmpeg-addon');
        const result = await encodeSilk(input, root);
        expect(result.converted).toBe(true);
        expect(result.duration).toBe(3);
        expect(fs.readFileSync(result.path, 'utf8')).toBe('\x02#!SILK_V3payload');
        expect(addon.convertToNTSilkTct).toHaveBeenCalledWith(input, result.path);
    });

    it('removes partial output when native conversion fails, preserving the source and error', async () => {
        const input = path.join(root, 'voice.wav');
        fs.writeFileSync(input, 'RIFF');
        const failure = new Error('conversion interrupted');
        addon.convertToNTSilkTct.mockImplementation(async (_input, output) => {
            await fs.promises.writeFile(output, 'partial');
            throw failure;
        });
        const { encodeSilk } = await import('../../src/highway/ffmpeg-addon');
        await expect(encodeSilk(input, root)).rejects.toBe(failure);
        expect(fs.readdirSync(root)).toEqual(['voice.wav']);
        expect(fs.readFileSync(input, 'utf8')).toBe('RIFF');
    });
});
