import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { afterEach, describe, expect, it } from 'vitest';
import { JsonSysFaceCatalogStorage } from '../src/sys-face-storage';
import type { SysFaceCatalogSnapshot } from '../src/sys-face-store';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function fixturePath(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'snowluma-sys-face-'));
  roots.push(root);
  return join(root, 'nested', 'sys-faces.json');
}

const SNAPSHOT: SysFaceCatalogSnapshot = {
  schemaVersion: 1,
  fetchedAt: 123,
  packs: [{
    packName: '经典',
    emojis: [{
      qSid: '14', qDes: '/微笑', emCode: '14', qCid: null,
      aniStickerType: null, aniStickerPackId: null, aniStickerId: null,
      url: null, emojiNameAlias: ['smile'],
      aniStickerWidth: null, aniStickerHeight: null,
    }],
  }],
};

describe('JsonSysFaceCatalogStorage', () => {
  it('returns null for a missing cache and round-trips an atomic save', async () => {
    const file = await fixturePath();
    const storage = new JsonSysFaceCatalogStorage(file);

    await expect(storage.load()).resolves.toBeNull();
    await storage.save(SNAPSHOT);
    await expect(storage.load()).resolves.toEqual(SNAPSHOT);
    expect(JSON.parse(await readFile(file, 'utf8'))).toEqual(SNAPSHOT);
  });

  it('surfaces malformed JSON with the cache path instead of ignoring it', async () => {
    const file = await fixturePath();
    const storage = new JsonSysFaceCatalogStorage(file);
    await storage.save(SNAPSHOT);
    await writeFile(file, '{broken', 'utf8');

    await expect(storage.load()).rejects.toThrow(file);
  });
});
