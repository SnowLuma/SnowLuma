import { access, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { updateDirectory } from '../src/update/files';

vi.mock('node:fs/promises', async (original) => {
    const actual = await original<typeof import('node:fs/promises')>();
    return { ...actual, access: vi.fn(actual.access) };
});

let root: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-directory-test-'));
});
afterEach(async () => {
    vi.mocked(access).mockReset();
    const actual = await vi.importActual<typeof import('node:fs/promises')>('node:fs/promises');
    vi.mocked(access).mockImplementation(actual.access);
    await rm(root, { recursive: true, force: true });
});

describe('update staging directory', () => {
    it('isolates installations and reuses their staging directory', async () => {
        const directory = await updateDirectory(path.join(root, 'app'), root);
        expect(path.dirname(directory)).toBe(root);
        expect(await updateDirectory(path.join(root, 'app'), root)).toBe(directory);
        expect(await updateDirectory(path.join(root, 'other'), root)).not.toBe(directory);
    });

    it('uses local tmp when system tmp is not writable and keeps it discoverable', async () => {
        vi.mocked(access).mockRejectedValueOnce(
            Object.assign(new Error('denied'), { code: 'EACCES' }),
        );
        const directory = await updateDirectory(root, root);
        expect(directory).toBe(path.join(root, 'tmp', 'update'));
        expect(await updateDirectory(root, root)).toBe(directory);
    });

    it('surfaces unexpected filesystem failures', async () => {
        vi.mocked(access).mockRejectedValueOnce(
            Object.assign(new Error('I/O failure'), { code: 'EIO' }),
        );
        await expect(updateDirectory(root, root)).rejects.toThrow('I/O failure');
    });
});
