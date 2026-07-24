import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { StreamStorage } from '../src/stream-storage';

let container: string;
let root: string;
let storage: StreamStorage;

function writeSized(filePath: string, bytes: number): void {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, Buffer.alloc(bytes));
}

beforeEach(() => {
  container = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-stream-storage-'));
  root = path.join(container, 'managed');
  storage = new StreamStorage(root);
});

afterEach(() => {
  vi.restoreAllMocks();
  fs.rmSync(container, { recursive: true, force: true });
});

describe('StreamStorage', () => {
  it('summarizes only the managed stream root', () => {
    writeSized(path.join(storage.uploadDir, 'upload.bin'), 10);
    writeSized(path.join(storage.downloadDir, 'download.bin'), 20);
    writeSized(path.join(root, '..', `${path.basename(root)}-outside.bin`), 99);

    expect(storage.snapshot()).toEqual({
      totalBytes: 30,
      fileCount: 2,
      activeItemCount: 0,
    });
  });

  it('clears inactive files while preserving every path of an active transfer', () => {
    const activeDir = path.join(storage.uploadDir, 'active');
    const activeChunk = path.join(activeDir, '0.chunk');
    const activeFinal = path.join(storage.uploadDir, 'active__file.bin');
    const staleUpload = path.join(storage.uploadDir, 'stale.bin');
    const staleDownload = path.join(storage.downloadDir, 'stale.bin');
    writeSized(activeChunk, 3);
    writeSized(activeFinal, 5);
    writeSized(staleUpload, 7);
    writeSized(staleDownload, 11);
    const release = storage.registerActiveItem([activeDir, activeFinal]);

    expect(storage.clearInactive()).toEqual({
      deletedFiles: 2,
      freedBytes: 18,
      skippedActiveItems: 1,
      failures: [],
    });
    expect(fs.existsSync(activeChunk)).toBe(true);
    expect(fs.existsSync(activeFinal)).toBe(true);
    expect(fs.existsSync(staleUpload)).toBe(false);
    expect(fs.existsSync(staleDownload)).toBe(false);

    release();
    expect(storage.clearInactive()).toMatchObject({
      deletedFiles: 2,
      freedBytes: 8,
      skippedActiveItems: 0,
      failures: [],
    });
  });

  it('rejects active paths outside its managed root', () => {
    expect(() => storage.registerActiveItem([path.join(root, '..', 'outside')]))
      .toThrow(/outside/i);
  });

  it('does not hide canonicalization failures while establishing its root', () => {
    vi.spyOn(fs, 'realpathSync').mockImplementationOnce(() => {
      throw Object.assign(new Error('canonicalization denied'), { code: 'EACCES' });
    });

    expect(() => new StreamStorage(path.join(container, 'another-managed')))
      .toThrow(/canonicalization denied/);
  });

  it('does not treat root inspection failures as a missing ancestor', () => {
    const candidate = path.join(container, 'inspection-denied');
    const originalLstat = fs.lstatSync.bind(fs);
    vi.spyOn(fs, 'lstatSync').mockImplementation((filePath) => {
      if (String(filePath) === candidate) {
        throw Object.assign(new Error('root inspection denied'), { code: 'EACCES' });
      }
      return originalLstat(filePath);
    });

    expect(() => new StreamStorage(candidate))
      .toThrow(/root inspection denied/);
  });

  it('removes a symlink without following it outside the managed root', () => {
    const externalDir = path.join(root, '..', `${path.basename(root)}-external`);
    const externalFile = path.join(externalDir, 'keep.bin');
    writeSized(externalFile, 12);
    fs.mkdirSync(storage.uploadDir, { recursive: true });
    fs.symlinkSync(externalDir, path.join(storage.uploadDir, 'linked'));

    const result = storage.clearInactive();

    expect(result.deletedFiles).toBe(1);
    expect(result.failures).toEqual([]);
    expect(fs.existsSync(externalFile)).toBe(true);
  });
});
