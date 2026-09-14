import { mkdir, readFile, rename, unlink, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { SysFaceCatalogSnapshot, SysFaceCatalogStorage } from './sys-face-store';

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object'
    && error !== null
    && 'code' in error
    && (error as { code?: unknown }).code === code;
}

/** Atomic JSON persistence for the process-wide system-face catalog. */
export class JsonSysFaceCatalogStorage implements SysFaceCatalogStorage {
  constructor(readonly filePath: string) {}

  async load(): Promise<SysFaceCatalogSnapshot | null> {
    let text: string;
    try {
      text = await readFile(this.filePath, 'utf8');
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return null;
      throw new Error(`failed to read system face catalog ${this.filePath}`, { cause: error });
    }

    try {
      return JSON.parse(text) as SysFaceCatalogSnapshot;
    } catch (error) {
      throw new Error(`failed to parse system face catalog ${this.filePath}`, { cause: error });
    }
  }

  async save(snapshot: SysFaceCatalogSnapshot): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const temporaryPath = `${this.filePath}.tmp-${process.pid}-${Date.now()}`;
    try {
      await writeFile(temporaryPath, JSON.stringify(snapshot, null, 2), 'utf8');
      await rename(temporaryPath, this.filePath);
    } catch (error) {
      try {
        await unlink(temporaryPath);
      } catch (cleanupError) {
        if (!isErrno(cleanupError, 'ENOENT')) {
          throw new AggregateError(
            [error, cleanupError],
            `failed to persist system face catalog ${this.filePath} and remove its temporary file`,
          );
        }
      }
      throw new Error(`failed to persist system face catalog ${this.filePath}`, { cause: error });
    }
  }
}
