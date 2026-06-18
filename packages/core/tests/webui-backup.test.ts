import { describe, it, expect } from 'vitest';
import { BACKUP_FILES, specFor, buildBackup, validateBackup, planRestore } from '../src/webui/backup';

const TS = '2026-06-18T00:00:00.000Z';

function reader(map: Record<string, Buffer>) {
  return (name: string): Buffer | null => map[name] ?? null;
}

describe('buildBackup', () => {
  it('includes present non-credential files and skips missing ones', () => {
    const b = buildBackup(reader({
      'runtime.json': Buffer.from('{"webuiPort":5099}'),
      'ui.json': Buffer.from('{}'),
    }), [], { includeCredentials: false }, TS);
    expect(b.version).toBe(1);
    expect(b.app).toBe('snowluma');
    expect(b.createdAt).toBe(TS);
    expect(Object.keys(b.files).sort()).toEqual(['runtime.json', 'ui.json']);
    expect(b.files['runtime.json']).toEqual({ encoding: 'utf8', data: '{"webuiPort":5099}' });
  });

  it('treats all OneBot config (global + per-uin), webui.json, key.pem as credentials', () => {
    const map = {
      'runtime.json': Buffer.from('{}'),
      'webui.json': Buffer.from('{"hash":"x"}'),
      'key.pem': Buffer.from('KEY'),
      'cert.pem': Buffer.from('CERT'),
      'onebot.json': Buffer.from('{"accessToken":"t"}'),
      'onebot_12345.json': Buffer.from('{"accessToken":"t2"}'),
    };
    const perUin = ['onebot_12345.json'];
    const without = buildBackup(reader(map), perUin, { includeCredentials: false }, TS);
    // only public files survive a no-credentials export
    expect(Object.keys(without.files).sort()).toEqual(['cert.pem', 'runtime.json']);
    const withCreds = buildBackup(reader(map), perUin, { includeCredentials: true }, TS);
    expect(Object.keys(withCreds.files).sort()).toEqual(
      ['cert.pem', 'key.pem', 'onebot.json', 'onebot_12345.json', 'runtime.json', 'webui.json'],
    );
  });

  it('base64-encodes binary files (background image)', () => {
    const png = Buffer.from([0x89, 0x50, 0x4e, 0x47]);
    const b = buildBackup(reader({ 'ui-assets/background': png }), [], { includeCredentials: false }, TS);
    expect(b.files['ui-assets/background']).toEqual({ encoding: 'base64', data: png.toString('base64') });
  });
});

describe('specFor', () => {
  it('resolves static names and per-uin onebot pattern; rejects others', () => {
    expect(specFor('runtime.json')?.credential).toBe(false);
    expect(specFor('onebot.json')?.credential).toBe(true);
    expect(specFor('onebot_98765.json')).toEqual({ name: 'onebot_98765.json', binary: false, credential: true });
    expect(specFor('onebot_.json')).toBeNull();
    expect(specFor('../evil')).toBeNull();
    expect(specFor('onebot_12.json.bak')).toBeNull();
  });
});

describe('validateBackup', () => {
  const good = { version: 1, app: 'snowluma', files: { 'runtime.json': { encoding: 'utf8', data: '{}' } } };

  it('accepts a well-formed bundle (incl. per-uin onebot)', () => {
    expect(validateBackup(good).ok).toBe(true);
    expect(validateBackup({ ...good, files: { 'onebot_42.json': { encoding: 'utf8', data: '{}' } } }).ok).toBe(true);
  });

  it('rejects a non-object / wrong app / wrong version', () => {
    expect(validateBackup(null).ok).toBe(false);
    expect(validateBackup({ ...good, app: 'other' }).ok).toBe(false);
    expect(validateBackup({ ...good, version: 999 }).ok).toBe(false);
  });

  it('rejects an unknown / path-traversal filename', () => {
    expect(validateBackup({ ...good, files: { '../evil': { encoding: 'utf8', data: 'x' } } }).ok).toBe(false);
    expect(validateBackup({ ...good, files: { 'unknown.json': { encoding: 'utf8', data: 'x' } } }).ok).toBe(false);
    expect(validateBackup({ ...good, files: { 'onebot_../x.json': { encoding: 'utf8', data: 'x' } } }).ok).toBe(false);
  });

  it('rejects a malformed entry', () => {
    expect(validateBackup({ ...good, files: { 'runtime.json': { encoding: 'rot13', data: 'x' } } }).ok).toBe(false);
    expect(validateBackup({ ...good, files: { 'runtime.json': { encoding: 'utf8' } } }).ok).toBe(false);
  });
});

describe('planRestore', () => {
  it('decodes restored files to bytes (utf8 + base64)', () => {
    const png = Buffer.from([1, 2, 3, 4]);
    const backup = {
      version: 1, app: 'snowluma',
      files: {
        'runtime.json': { encoding: 'utf8' as const, data: '{"a":1}' },
        'ui-assets/background': { encoding: 'base64' as const, data: png.toString('base64') },
      },
    };
    const { restore, skipped } = planRestore(backup, { restoreCredentials: false });
    expect(skipped).toEqual([]);
    const byName = Object.fromEntries(restore.map((r) => [r.name, r.data]));
    expect(byName['runtime.json'].toString()).toBe('{"a":1}');
    expect(byName['ui-assets/background'].equals(png)).toBe(true);
  });

  it('skips all credential files unless restoreCredentials', () => {
    const backup = {
      version: 1, app: 'snowluma',
      files: {
        'runtime.json': { encoding: 'utf8' as const, data: '{}' },
        'webui.json': { encoding: 'utf8' as const, data: '{"hash":"x"}' },
        'key.pem': { encoding: 'utf8' as const, data: 'KEY' },
        'onebot.json': { encoding: 'utf8' as const, data: '{"accessToken":"t"}' },
        'onebot_7.json': { encoding: 'utf8' as const, data: '{"accessToken":"t"}' },
      },
    };
    const skip = planRestore(backup, { restoreCredentials: false });
    expect(skip.restore.map((r) => r.name)).toEqual(['runtime.json']);
    expect(skip.skipped.sort()).toEqual(['key.pem', 'onebot.json', 'onebot_7.json', 'webui.json']);
    const keep = planRestore(backup, { restoreCredentials: true });
    expect(keep.restore.map((r) => r.name).sort()).toEqual(
      ['key.pem', 'onebot.json', 'onebot_7.json', 'runtime.json', 'webui.json'],
    );
  });
});

it('BACKUP_FILES marks webui.json / key.pem / onebot.json as credentials, cert.pem public', () => {
  const creds = BACKUP_FILES.filter((f) => f.credential).map((f) => f.name).sort();
  expect(creds).toEqual(['key.pem', 'onebot.json', 'webui.json']);
  expect(specFor('cert.pem')?.credential).toBe(false);
});
