import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

export interface StreamStorageSnapshot {
  totalBytes: number;
  fileCount: number;
  activeItemCount: number;
}

export interface StreamStorageCleanupResult {
  deletedFiles: number;
  freedBytes: number;
  skippedActiveItems: number;
  failures: Array<{ item: string; message: string }>;
}

export class StreamStorage {
  readonly root: string;
  readonly uploadDir: string;
  readonly downloadDir: string;

  private readonly activeItems = new Map<number, string[]>();
  private nextActiveItemId = 1;

  constructor(root: string) {
    this.root = resolveManagedRoot(root);
    this.uploadDir = path.join(this.root, 'upload');
    this.downloadDir = path.join(this.root, 'download');
  }

  /**
   * Create a directory inside the managed root without following a substituted
   * directory link. Existing directories remain usable when they belong to the
   * current account and cannot be modified by other local accounts.
   */
  ensureDirectory(directory: string): void {
    const resolved = path.resolve(directory);
    if (resolved !== this.root && !isStrictDescendant(this.root, resolved)) {
      throw new Error(`stream directory is outside the managed root: ${directory}`);
    }

    let current = this.root;
    ensureManagedDirectory(current);
    const relative = path.relative(this.root, resolved);
    if (!relative) return;
    for (const segment of relative.split(path.sep)) {
      current = path.join(current, segment);
      ensureManagedDirectory(current);
    }
  }

  registerActiveItem(paths: string[]): () => void {
    const normalized = paths.map((item) => {
      const resolved = path.resolve(item);
      if (!isStrictDescendant(this.root, resolved)) {
        throw new Error(`active stream path is outside the managed root: ${item}`);
      }
      return resolved;
    });
    const id = this.nextActiveItemId++;
    this.activeItems.set(id, normalized);
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.activeItems.delete(id);
    };
  }

  snapshot(): StreamStorageSnapshot {
    if (!this.assertRootDirectoryOrMissing()) {
      return {
        totalBytes: 0,
        fileCount: 0,
        activeItemCount: this.activeItems.size,
      };
    }

    let totalBytes = 0;
    let fileCount = 0;
    this.walkFiles(this.root, (stat) => {
      totalBytes += stat.size;
      fileCount += 1;
    });
    return { totalBytes, fileCount, activeItemCount: this.activeItems.size };
  }

  clearInactive(): StreamStorageCleanupResult {
    const result: StreamStorageCleanupResult = {
      deletedFiles: 0,
      freedBytes: 0,
      skippedActiveItems: this.activeItems.size,
      failures: [],
    };
    if (!this.assertRootDirectoryOrMissing()) return result;

    const activePaths = [...this.activeItems.values()].flat();
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(this.root, { withFileTypes: true });
    } catch (error) {
      result.failures.push({ item: '.', message: this.publicErrorMessage(error) });
      return result;
    }
    for (const entry of entries) {
      this.clearNode(path.join(this.root, entry.name), activePaths, result);
    }
    return result;
  }

  private assertRootDirectoryOrMissing(): boolean {
    try {
      const stat = fs.lstatSync(this.root);
      assertManagedDirectory(this.root, stat);
      return true;
    } catch (error) {
      if (isMissing(error)) return false;
      throw error;
    }
  }

  private walkFiles(dir: string, visit: (stat: fs.Stats) => void): void {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const entry of entries) {
      const item = path.join(dir, entry.name);
      const stat = fs.lstatSync(item);
      if (stat.isDirectory()) this.walkFiles(item, visit);
      else visit(stat);
    }
  }

  private clearNode(
    item: string,
    activePaths: string[],
    result: StreamStorageCleanupResult,
  ): void {
    const resolved = path.resolve(item);
    if (activePaths.some((active) => isSameOrDescendant(active, resolved))) return;

    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(resolved);
    } catch (error) {
      if (!isMissing(error)) {
        result.failures.push({
          item: this.displayPath(resolved),
          message: this.publicErrorMessage(error),
        });
      }
      return;
    }

    if (!stat.isDirectory()) {
      try {
        fs.unlinkSync(resolved);
        result.deletedFiles += 1;
        result.freedBytes += stat.size;
      } catch (error) {
        if (!isMissing(error)) {
          result.failures.push({
            item: this.displayPath(resolved),
            message: this.publicErrorMessage(error),
          });
        }
      }
      return;
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(resolved, { withFileTypes: true });
    } catch (error) {
      result.failures.push({
        item: this.displayPath(resolved),
        message: this.publicErrorMessage(error),
      });
      return;
    }
    for (const entry of entries) {
      this.clearNode(path.join(resolved, entry.name), activePaths, result);
    }

    try {
      if (fs.readdirSync(resolved).length === 0) fs.rmdirSync(resolved);
    } catch (error) {
      if (!isMissing(error)) {
        result.failures.push({
          item: this.displayPath(resolved),
          message: this.publicErrorMessage(error),
        });
      }
    }
  }

  private displayPath(item: string): string {
    const relative = path.relative(this.root, item);
    return relative || '.';
  }

  private publicErrorMessage(error: unknown): string {
    return errorMessage(error).split(this.root).join('[临时目录]');
  }
}

function isStrictDescendant(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative !== '' && !relative.startsWith('..') && !path.isAbsolute(relative);
}

function isSameOrDescendant(root: string, candidate: string): boolean {
  return root === candidate || isStrictDescendant(root, candidate);
}

function isMissing(error: unknown): boolean {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function assertManagedDirectory(directory: string, stat: fs.Stats): void {
  if (stat.isSymbolicLink()) {
    throw new Error(`managed stream directory must not be a symbolic link: ${directory}`);
  }
  if (!stat.isDirectory()) {
    throw new Error(`managed stream path is not a directory: ${directory}`);
  }

  const currentUid = typeof process.getuid === 'function' ? process.getuid() : undefined;
  if (currentUid !== undefined && stat.uid !== currentUid) {
    throw new Error(`managed stream directory is owned by another account: ${directory}`);
  }
  if (process.platform !== 'win32' && (stat.mode & 0o022) !== 0) {
    throw new Error(`managed stream directory is writable by other accounts: ${directory}`);
  }
}

function ensureManagedDirectory(directory: string): void {
  let stat: fs.Stats;
  try {
    stat = fs.lstatSync(directory);
  } catch (error) {
    if (!isMissing(error)) throw error;
    try {
      fs.mkdirSync(directory, { mode: 0o700 });
    } catch (mkdirError) {
      if (!(mkdirError instanceof Error && 'code' in mkdirError && mkdirError.code === 'EEXIST')) {
        throw mkdirError;
      }
    }
    stat = fs.lstatSync(directory);
  }
  assertManagedDirectory(directory, stat);
}

function resolveManagedRoot(input: string): string {
  const absolute = path.resolve(input);
  try {
    const stat = fs.lstatSync(absolute);
    assertManagedDirectory(absolute, stat);
    return fs.realpathSync(absolute);
  } catch (error) {
    if (!isMissing(error)) throw error;
  }

  const parent = path.dirname(absolute);
  const parentStat = fs.statSync(parent);
  if (!parentStat.isDirectory()) {
    throw new Error(`managed stream parent is not a directory: ${parent}`);
  }
  return path.join(fs.realpathSync(parent), path.basename(absolute));
}

export const streamStorage = new StreamStorage(path.join(os.tmpdir(), 'snowluma-stream'));
export const STREAM_ROOT = streamStorage.root;
export const STREAM_UPLOAD_DIR = streamStorage.uploadDir;
export const STREAM_DOWNLOAD_DIR = streamStorage.downloadDir;

export function registerActiveStreamItem(paths: string[]): () => void {
  return streamStorage.registerActiveItem(paths);
}

export function ensureStreamDirectory(directory: string): void {
  streamStorage.ensureDirectory(directory);
}

export function snapshotStreamStorage(): StreamStorageSnapshot {
  return streamStorage.snapshot();
}

export function clearInactiveStreamStorage(): StreamStorageCleanupResult {
  return streamStorage.clearInactive();
}
