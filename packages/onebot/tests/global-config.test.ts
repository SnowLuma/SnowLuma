import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  defaultGlobalSettings,
  loadGlobalSettings,
  normalizeGlobalSettings,
  saveGlobalSettings,
} from '../src/global-config';

describe('global-config (config/snowluma.json)', () => {
  let tempDir: string;
  let prevCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-global-config-'));
    prevCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('defaults to an empty fallback list (feature off)', () => {
    expect(defaultGlobalSettings()).toEqual({ rkey: { fallbackServers: [] } });
    expect(loadGlobalSettings()).toEqual({ rkey: { fallbackServers: [] } });
  });

  it('keeps only well-formed http(s) URLs, trims, and dedupes', () => {
    const out = normalizeGlobalSettings({
      rkey: { fallbackServers: ['  https://a.example/r ', 'ftp://x', 'not-a-url', 'https://', 'https://a.example/r', 'http://b.example/r', 42] },
    });
    // 'https://' (no host) and non-http schemes are dropped.
    expect(out.rkey.fallbackServers).toEqual(['https://a.example/r', 'http://b.example/r']);
  });

  it('ignores a malformed rkey block', () => {
    expect(normalizeGlobalSettings({ rkey: 'nope' })).toEqual({ rkey: { fallbackServers: [] } });
    expect(normalizeGlobalSettings(null)).toEqual({ rkey: { fallbackServers: [] } });
  });

  it('round-trips through save → disk → load', () => {
    const saved = saveGlobalSettings({ rkey: { fallbackServers: ['https://r.example/rkey', 'bogus'] } });
    expect(saved.rkey.fallbackServers).toEqual(['https://r.example/rkey']);

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'config', 'snowluma.json'), 'utf8'));
    expect(onDisk).toEqual({ rkey: { fallbackServers: ['https://r.example/rkey'] } });

    expect(loadGlobalSettings().rkey.fallbackServers).toEqual(['https://r.example/rkey']);
  });

  it('section-merges on save: a partial write never wipes a sibling section', () => {
    saveGlobalSettings({ rkey: { fallbackServers: ['https://r.example/rkey'] } });
    // A save that omits `rkey` (e.g. a future tenant saving only its own block)
    // must preserve the existing rkey servers.
    const after = saveGlobalSettings({});
    expect(after.rkey.fallbackServers).toEqual(['https://r.example/rkey']);
    expect(loadGlobalSettings().rkey.fallbackServers).toEqual(['https://r.example/rkey']);
  });

  it('falls back to defaults when the file is corrupt', () => {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'config', 'snowluma.json'), '{ not json', 'utf8');
    expect(loadGlobalSettings()).toEqual({ rkey: { fallbackServers: [] } });
  });
});
