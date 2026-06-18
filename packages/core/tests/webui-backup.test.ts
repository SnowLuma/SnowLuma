import { describe, it, expect } from 'vitest';
import { BACKUP_FILES, buildBackup, validateBackup, applyBackup } from '../src/webui/backup';

const TS = '2026-06-18T00:00:00.000Z';

function reader(map: Record<string, Buffer>) {
  return (name: string): Buffer | null => map[name] ?? null;
}

describe('buildBackup', () => {
  it('includes present non-credential files and skips missing ones', () => {
    const b = buildBackup(reader({
      'runtime.json': Buffer.from('{"webuiPort":5099}'),
      'ui.json': Buffer.from('{}'),
    }), { includeCredentials: false }, TS);
    expect(b.version).toBe(1);
    expect(b.app).toBe('snowluma');
    expect(b.createdAt).toBe(TS);
    expect(Object.keys(b.files).sort()).toEqual(['runtime.json', 'ui.json']);
    expect(b.files['runtime.json']).toEqual({ encoding: 'utf8', data: '{"webuiPort":5099}' });
  });

  it('excludes credential files (webui.json, key.pem) unless includeCredentials', () => {
    const map = {
      'runtime.json': Buffer.from('{}'),
      'webui.json': Buffer.from('{"hash":"x"}'),
      'key.pem': Buffer.from('KEY'),
      'cert.pem': Buffer.from('CERT'),
    };
    const without = buildBackup(reader(map), { includeCredentials: false }, TS);
    expect(Object.keys(without.files).sort()).toEqual(['cert.pem', 'runtime.json']); // cert is public
    const withCreds = buildBackup(reader(map), { includeCredentials: true }, TS);
    expect(Object.keys(withCreds.files).sort()).toEqual(['cert.pem', 'key.pem', 'runtime.json', 'webui.json']);
  });

  it('base64-encodes binary files (background image)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const b = buildBackup(reader({ 'ui-assets/background': png }), { includeCredentials: false }, TS);
    expect(b.files['ui-assets/background']).toEqual({ encoding: 'base64', data: png.toString('base64') });
  });
});

describe('validateBackup', () => {
  const good = { version: 1, app: 'snowluma', files: { 'runtime.json': { encoding: 'utf8', data: '{}' } } };

  it('accepts a well-formed bundle', () => {
    const r = validateBackup(good);
    expect(r.ok).toBe(true);
  });

  it('rejects a non-object / wrong app / wrong version', () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup({ ...good, app: 'other' }).ok).toBe(false);
    expect(validateBackup({ ...good, version: 999 }).ok).toBe(false);
  });

  it('rejects an unknown / path-traversal filename', () => {
    expect(validateBackup({ ...good, files: { '../evil': { encoding: 'utf8', data: 'x' } } }).ok).toBe(false);
    expect(validateBackup({ ...good, files: { 'unknown.json': { encoding: 'utf8', data: 'x' } } }).ok).toBe(false);
  });

  it('rejects a malformed entry', () => {
    expect(validateBackup({ ...good, files: { 'runtime.json': { encoding: 'rot13', data: 'x' } } }).ok).toBe(false);
    expect(validateBackup({ ...good, files: { 'runtime.json': { encoding: 'utf8' } } }).ok).toBe(false);
  });
});

describe('applyBackup', () => {
  function makeIo() {
    const snapshots: string[] = [];
    const writes: Record<string, string> = {};
    return {
      snapshots, writes,
      io: {
        snapshot: (name: string) => { snapshots.push(name); },
        write: (name: string, data: Buffer) => { writes[name] = data.toString(); },
      },
    };
  }

  it('snapshots then writes each restored file', () => {
    const { io, snapshots, writes } = makeIo();
    const backup = { version: 1, app: 'snowluma', files: { 'runtime.json': { encoding: 'utf8' as const, data: '{"a":1}' } } };
    const res = applyBackup(backup, io, { restoreCredentials: false });
    expect(snapshots).toContain('runtime.json');
    expect(writes['runtime.json']).toBe('{"a":1}');
    expect(res.restored).toEqual(['runtime.json']);
  });

  it('skips credential files unless restoreCredentials', () => {
    const { io, writes } = makeIo();
    const backup = {
      version: 1, app: 'snowluma',
      files: {
        'runtime.json': { encoding: 'utf8' as const, data: '{}' },
        'webui.json': { encoding: 'utf8' as const, data: '{"hash":"x"}' },
        'key.pem': { encoding: 'utf8' as const, data: 'KEY' },
      },
    };
    const res = applyBackup(backup, io, { restoreCredentials: false });
    expect(writes['webui.json']).toBeUndefined();
    expect(writes['key.pem']).toBeUndefined();
    expect(res.skipped.sort()).toEqual(['key.pem', 'webui.json']);
    expect(res.restored).toEqual(['runtime.json']);
  });

  it('restores credentials when opted in', () => {
    const { io, writes } = makeIo();
    const backup = { version: 1, app: 'snowluma', files: { 'webui.json': { encoding: 'utf8' as const, data: 'H' } } };
    applyBackup(backup, io, { restoreCredentials: true });
    expect(writes['webui.json']).toBe('H');
  });
});

it('BACKUP_FILES marks webui.json and key.pem as credentials', () => {
  const creds = BACKUP_FILES.filter((f) => f.credential).map((f) => f.name).sort();
  expect(creds).toEqual(['key.pem', 'webui.json']);
});
