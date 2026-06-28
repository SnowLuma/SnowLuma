import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  defaultGlobalSettings,
  loadGlobalSettings,
  migrateGlobalSettings,
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
    expect(defaultGlobalSettings()).toEqual({ rkey: { fallbackServers: [] }, musicSignUrl: '' });
    expect(loadGlobalSettings()).toEqual({ rkey: { fallbackServers: [] }, musicSignUrl: '' });
  });

  it('keeps only well-formed http(s) URLs, trims, and dedupes', () => {
    const out = normalizeGlobalSettings({
      rkey: { fallbackServers: ['  https://a.example/r ', 'ftp://x', 'not-a-url', 'https://', 'https://a.example/r', 'http://b.example/r', 42] },
    });
    // 'https://' (no host) and non-http schemes are dropped.
    expect(out.rkey.fallbackServers).toEqual(['https://a.example/r', 'http://b.example/r']);
  });

  it('ignores a malformed rkey block', () => {
    expect(normalizeGlobalSettings({ rkey: 'nope' })).toEqual({ rkey: { fallbackServers: [] }, musicSignUrl: '' });
    expect(normalizeGlobalSettings(null)).toEqual({ rkey: { fallbackServers: [] }, musicSignUrl: '' });
  });

  it('round-trips through save → disk → load', () => {
    const saved = saveGlobalSettings({ rkey: { fallbackServers: ['https://r.example/rkey', 'bogus'] } });
    expect(saved.rkey.fallbackServers).toEqual(['https://r.example/rkey']);

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'config', 'snowluma.json'), 'utf8'));
    expect(onDisk).toEqual({ rkey: { fallbackServers: ['https://r.example/rkey'] }, musicSignUrl: '' });

    expect(loadGlobalSettings().rkey.fallbackServers).toEqual(['https://r.example/rkey']);
  });

  it('section-merges on save: a partial write never wipes a sibling section', () => {
    saveGlobalSettings({ rkey: { fallbackServers: ['https://r.example/rkey'] } });
    // A save touching only musicSignUrl must preserve the rkey servers, and
    // vice-versa.
    const after = saveGlobalSettings({ musicSignUrl: 'https://sign.example/card' });
    expect(after.rkey.fallbackServers).toEqual(['https://r.example/rkey']);
    expect(after.musicSignUrl).toBe('https://sign.example/card');
    expect(saveGlobalSettings({ rkey: { fallbackServers: [] } }).musicSignUrl).toBe('https://sign.example/card');
  });

  it('normalizes + round-trips musicSignUrl (trimmed)', () => {
    expect(normalizeGlobalSettings({ musicSignUrl: '  https://s.example/c ' }).musicSignUrl).toBe('https://s.example/c');
    const saved = saveGlobalSettings({ musicSignUrl: 'https://s.example/c' });
    expect(saved.musicSignUrl).toBe('https://s.example/c');
    expect(loadGlobalSettings().musicSignUrl).toBe('https://s.example/c');
  });

  describe('migrateGlobalSettings (musicSignUrl copy-up)', () => {
    function writeOnebot(file: string, body: unknown) {
      const dir = path.join(tempDir, 'config');
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, file), JSON.stringify(body), 'utf8');
    }

    it('lifts a legacy per-UIN musicSignUrl into the global store', () => {
      writeOnebot('onebot_123.json', { musicSignUrl: 'https://legacy.example/sign' });
      migrateGlobalSettings();
      expect(loadGlobalSettings().musicSignUrl).toBe('https://legacy.example/sign');
    });

    it('is a no-op when the global value is already set', () => {
      saveGlobalSettings({ musicSignUrl: 'https://kept.example/sign' });
      writeOnebot('onebot_123.json', { musicSignUrl: 'https://legacy.example/sign' });
      migrateGlobalSettings();
      expect(loadGlobalSettings().musicSignUrl).toBe('https://kept.example/sign');
    });

    it('takes the first file and tolerates differing/empty values across files', () => {
      writeOnebot('onebot.json', { musicSignUrl: '' });               // empty → skipped
      writeOnebot('onebot_111.json', { musicSignUrl: 'https://a.example/s' });
      writeOnebot('onebot_222.json', { musicSignUrl: 'https://b.example/s' });
      migrateGlobalSettings();
      // onebot.json sorts first but is empty; onebot_111 is the first non-empty.
      expect(loadGlobalSettings().musicSignUrl).toBe('https://a.example/s');
    });

    it('does nothing when no legacy value exists', () => {
      writeOnebot('onebot_123.json', { networks: {} });
      migrateGlobalSettings();
      expect(loadGlobalSettings().musicSignUrl).toBe('');
    });

    it('migrates a value carried by the base onebot.json', () => {
      writeOnebot('onebot.json', { musicSignUrl: 'https://base.example/s' });
      migrateGlobalSettings();
      expect(loadGlobalSettings().musicSignUrl).toBe('https://base.example/s');
    });

    it('skips an invalid earlier value and migrates the first VALID one', () => {
      writeOnebot('onebot.json', { musicSignUrl: 'not-a-url' });        // earlier-sorting garbage
      writeOnebot('onebot_111.json', { musicSignUrl: 'https://real.example/s' });
      migrateGlobalSettings();
      expect(loadGlobalSettings().musicSignUrl).toBe('https://real.example/s');
    });

    it('does NOT re-copy after an intentional clear-to-empty (presence guard)', () => {
      // Operator cleared the global value to '' (the key is present in the file)…
      saveGlobalSettings({ musicSignUrl: '' });
      // …while a stale legacy value still lingers.
      writeOnebot('onebot_123.json', { musicSignUrl: 'https://legacy.example/sign' });
      migrateGlobalSettings();
      expect(loadGlobalSettings().musicSignUrl).toBe(''); // stays cleared, not reverted
    });

    it('is a safe no-op when config/ does not exist', () => {
      // fresh cwd, no config dir at all
      expect(() => migrateGlobalSettings()).not.toThrow();
      expect(loadGlobalSettings().musicSignUrl).toBe('');
    });
  });

  it('falls back to defaults when the file is corrupt', () => {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'config', 'snowluma.json'), '{ not json', 'utf8');
    expect(loadGlobalSettings()).toEqual({ rkey: { fallbackServers: [] }, musicSignUrl: '' });
  });
});
