import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import path from 'node:path';
import { qqDataRoots, qqDataRootsForPid } from '../src/qq-account/paths';

const files = vi.hoisted(() => ({ read: vi.fn() }));
vi.mock('node:fs', () => ({ readFileSync: files.read }));
const platform = process.platform;

beforeEach(() => {
    Object.defineProperty(process, 'platform', { value: 'linux', configurable: true });
});
afterEach(() => {
    Object.defineProperty(process, 'platform', { value: platform, configurable: true });
    files.read.mockReset();
});

describe('account data root isolation', () => {
    it('uses the client HOME and honours its XDG configuration', () => {
        files.read.mockReturnValue('HOME=/clients/a\0IGNORED=value\0');
        expect(qqDataRootsForPid(42)).toEqual([path.join('/clients/a', '.config', 'QQ')]);
        files.read.mockReturnValue('HOME=/clients/a\0XDG_CONFIG_HOME=/clients/config\0');
        expect(qqDataRootsForPid(42)).toEqual([path.join('/clients/config', 'QQ')]);
    });

    it('does not guess a HOME when the client environment has none', () => {
        files.read.mockReturnValue('OTHER=value\0');
        expect(qqDataRootsForPid(42)).toEqual([]);
    });

    it('reports no root for an exited process', () => {
        files.read.mockImplementation(() => {
            throw Object.assign(new Error('gone'), { code: 'ENOENT' });
        });
        expect(qqDataRootsForPid(42)).toEqual([]);
    });

    it('surfaces permission failures instead of reading another user directory', () => {
        const error = Object.assign(new Error('denied'), { code: 'EACCES' });
        files.read.mockImplementation(() => {
            throw error;
        });
        expect(() => qqDataRootsForPid(42)).toThrow(error);
    });

    it('uses only the configured Windows data root', () => {
        Object.defineProperty(process, 'platform', { value: 'win32', configurable: true });
        files.read.mockReturnValue('[UserDataSet]\nUserDataSavePath=D:\\QQ\\Tencent Files\n');
        expect(qqDataRoots()).toEqual(['D:\\QQ\\Tencent Files']);
        expect(files.read).toHaveBeenCalledTimes(1);
    });
});
