import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  evaluatePasswordRules,
  isDevAuthMode,
  isStrongPassword,
  PASSWORD_RULES,
  prepareWebuiAuthStateForRestore,
  WebuiAuth,
} from '../src/webui/auth';
import { confirmTotpEnrollment, unwrapTotpSecret, type TotpPersistedState } from '../src/webui/totp';

const TS = '2026-06-18T00:00:00.000Z';
const HASH = 'ab'.repeat(64);
const SALT = 'cd'.repeat(16);
const STRONG = 'Correct-Horse-1!';
const STRONG_NEXT = 'Correct-Horse-2!';
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const T59_MS = 59_000;
const T59_CODE = '287082';

const VALID_TOTP: TotpPersistedState = {
  wrapSalt: '11'.repeat(16),
  iv: '22'.repeat(12),
  ciphertext: '33'.repeat(10),
  authTag: '44'.repeat(16),
  recoveryCodeHashes: ['55'.repeat(32), '66'.repeat(32)],
  lastUsedStep: 7,
  label: 'SnowLuma (testhost)',
};

const AUTH_ENV = ['SNOWLUMA_DEV_MODE', 'SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD'] as const;
const savedEnv: Record<string, string | undefined> = {};

beforeEach(() => {
  for (const key of AUTH_ENV) {
    savedEnv[key] = process.env[key];
    delete process.env[key];
  }
});

afterEach(() => {
  for (const key of AUTH_ENV) {
    if (savedEnv[key] === undefined) delete process.env[key];
    else process.env[key] = savedEnv[key];
  }
});

describe('PASSWORD_RULES / evaluatePasswordRules / isStrongPassword', () => {
  it('exposes the five published rule ids and labels in order', () => {
    expect(PASSWORD_RULES.map((rule) => ({ id: rule.id, label: rule.label }))).toEqual([
      { id: 'length', label: '长度不少于 10 位' },
      { id: 'lower', label: '包含小写字母' },
      { id: 'upper', label: '包含大写字母' },
      { id: 'special', label: '包含特殊符号 (!@#$%…)' },
      { id: 'no-space', label: '不包含空格' },
    ]);
  });

  it('marks every rule ok for a 10-character mixed password with a symbol', () => {
    expect(evaluatePasswordRules('Abcdefghi!')).toEqual([
      { id: 'length', label: '长度不少于 10 位', ok: true },
      { id: 'lower', label: '包含小写字母', ok: true },
      { id: 'upper', label: '包含大写字母', ok: true },
      { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: true },
      { id: 'no-space', label: '不包含空格', ok: true },
    ]);
    expect(isStrongPassword('Abcdefghi!')).toBe(true);
  });

  it('fails only length when the password is 9 characters', () => {
    expect(evaluatePasswordRules('Abcdefgh!')).toEqual([
      { id: 'length', label: '长度不少于 10 位', ok: false },
      { id: 'lower', label: '包含小写字母', ok: true },
      { id: 'upper', label: '包含大写字母', ok: true },
      { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: true },
      { id: 'no-space', label: '不包含空格', ok: true },
    ]);
    expect(isStrongPassword('Abcdefgh!')).toBe(false);
  });

  it('fails only lower when every letter is uppercase', () => {
    expect(evaluatePasswordRules('ABCDEFGHI!')).toEqual([
      { id: 'length', label: '长度不少于 10 位', ok: true },
      { id: 'lower', label: '包含小写字母', ok: false },
      { id: 'upper', label: '包含大写字母', ok: true },
      { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: true },
      { id: 'no-space', label: '不包含空格', ok: true },
    ]);
    expect(isStrongPassword('ABCDEFGHI!')).toBe(false);
  });

  it('fails only upper when every letter is lowercase', () => {
    expect(evaluatePasswordRules('abcdefghi!')).toEqual([
      { id: 'length', label: '长度不少于 10 位', ok: true },
      { id: 'lower', label: '包含小写字母', ok: true },
      { id: 'upper', label: '包含大写字母', ok: false },
      { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: true },
      { id: 'no-space', label: '不包含空格', ok: true },
    ]);
    expect(isStrongPassword('abcdefghi!')).toBe(false);
  });

  it('fails only special when the password is letters and digits', () => {
    expect(evaluatePasswordRules('Abcdefgh12')).toEqual([
      { id: 'length', label: '长度不少于 10 位', ok: true },
      { id: 'lower', label: '包含小写字母', ok: true },
      { id: 'upper', label: '包含大写字母', ok: true },
      { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: false },
      { id: 'no-space', label: '不包含空格', ok: true },
    ]);
    expect(isStrongPassword('Abcdefgh12')).toBe(false);
  });

  it('fails special and no-space when the only extra character is a space', () => {
    expect(evaluatePasswordRules('Abcdefgh i')).toEqual([
      { id: 'length', label: '长度不少于 10 位', ok: true },
      { id: 'lower', label: '包含小写字母', ok: true },
      { id: 'upper', label: '包含大写字母', ok: true },
      { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: false },
      { id: 'no-space', label: '不包含空格', ok: false },
    ]);
    expect(isStrongPassword('Abcdefgh i')).toBe(false);
  });

  it('fails every rule for an empty string, including no-space', () => {
    expect(evaluatePasswordRules('')).toEqual([
      { id: 'length', label: '长度不少于 10 位', ok: false },
      { id: 'lower', label: '包含小写字母', ok: false },
      { id: 'upper', label: '包含大写字母', ok: false },
      { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: false },
      { id: 'no-space', label: '不包含空格', ok: false },
    ]);
    expect(isStrongPassword('')).toBe(false);
  });
});

describe('isDevAuthMode', () => {
  it('is true only when SNOWLUMA_DEV_MODE is the string 1', () => {
    expect(isDevAuthMode()).toBe(false);

    process.env.SNOWLUMA_DEV_MODE = '';
    expect(isDevAuthMode()).toBe(false);

    process.env.SNOWLUMA_DEV_MODE = '0';
    expect(isDevAuthMode()).toBe(false);

    process.env.SNOWLUMA_DEV_MODE = 'true';
    expect(isDevAuthMode()).toBe(false);

    process.env.SNOWLUMA_DEV_MODE = '1';
    expect(isDevAuthMode()).toBe(true);
  });
});

describe('prepareWebuiAuthStateForRestore', () => {
  const base = {
    passwordHash: HASH,
    passwordSalt: SALT,
    mustChangePassword: false,
    generatedAt: TS,
    updatedAt: TS,
  };

  it('accepts a complete credential object and omits totp when it is absent or undefined', () => {
    expect(prepareWebuiAuthStateForRestore(base)).toEqual({
      passwordHash: HASH,
      passwordSalt: SALT,
      mustChangePassword: false,
      generatedAt: TS,
      updatedAt: TS,
    });
    expect(prepareWebuiAuthStateForRestore({ ...base, totp: undefined })).toEqual({
      passwordHash: HASH,
      passwordSalt: SALT,
      mustChangePassword: false,
      generatedAt: TS,
      updatedAt: TS,
    });
  });

  it('keeps mixed-case hash and salt hex and attaches a valid totp object', () => {
    const mixedHash = 'AB'.repeat(64);
    const mixedSalt = 'CD'.repeat(16);
    expect(prepareWebuiAuthStateForRestore({
      passwordHash: mixedHash,
      passwordSalt: mixedSalt,
      mustChangePassword: true,
      generatedAt: TS,
      updatedAt: '2026-06-19T12:34:56.000Z',
      totp: VALID_TOTP,
    })).toEqual({
      passwordHash: mixedHash,
      passwordSalt: mixedSalt,
      mustChangePassword: true,
      generatedAt: TS,
      updatedAt: '2026-06-19T12:34:56.000Z',
      totp: {
        wrapSalt: '11'.repeat(16),
        iv: '22'.repeat(12),
        ciphertext: '33'.repeat(10),
        authTag: '44'.repeat(16),
        recoveryCodeHashes: ['55'.repeat(32), '66'.repeat(32)],
        lastUsedStep: 7,
        label: 'SnowLuma (testhost)',
      },
    });
  });

  it('rejects a non-object credential state', () => {
    expect(() => prepareWebuiAuthStateForRestore(null)).toThrow('credential state must be an object');
    expect(() => prepareWebuiAuthStateForRestore(undefined)).toThrow('credential state must be an object');
    expect(() => prepareWebuiAuthStateForRestore([])).toThrow('credential state must be an object');
    expect(() => prepareWebuiAuthStateForRestore('x')).toThrow('credential state must be an object');
  });

  it('rejects a passwordHash that is not exactly 128 hexadecimal characters', () => {
    expect(() => prepareWebuiAuthStateForRestore({ ...base, passwordHash: 'ab'.repeat(63) }))
      .toThrow('passwordHash must be exactly 128 hexadecimal characters');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, passwordHash: `${HASH}0` }))
      .toThrow('passwordHash must be exactly 128 hexadecimal characters');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, passwordHash: 'gg'.repeat(64) }))
      .toThrow('passwordHash must be exactly 128 hexadecimal characters');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, passwordHash: 1 }))
      .toThrow('passwordHash must be exactly 128 hexadecimal characters');
  });

  it('rejects a passwordSalt that is not exactly 32 hexadecimal characters', () => {
    expect(() => prepareWebuiAuthStateForRestore({ ...base, passwordSalt: 'cd'.repeat(15) }))
      .toThrow('passwordSalt must be exactly 32 hexadecimal characters');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, passwordSalt: 'zz'.repeat(16) }))
      .toThrow('passwordSalt must be exactly 32 hexadecimal characters');
  });

  it('rejects a non-boolean mustChangePassword', () => {
    expect(() => prepareWebuiAuthStateForRestore({ ...base, mustChangePassword: 'false' }))
      .toThrow('mustChangePassword must be a boolean');
  });

  it('rejects generatedAt or updatedAt that are not parseable timestamps', () => {
    expect(() => prepareWebuiAuthStateForRestore({ ...base, generatedAt: 'not-a-timestamp' }))
      .toThrow('generatedAt must be a valid timestamp');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, generatedAt: 0 }))
      .toThrow('generatedAt must be a valid timestamp');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, updatedAt: '' }))
      .toThrow('updatedAt must be a valid timestamp');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, updatedAt: 'Invalid Date' }))
      .toThrow('updatedAt must be a valid timestamp');
  });

  it('rejects an unknown top-level field', () => {
    expect(() => prepareWebuiAuthStateForRestore({ ...base, note: 'x' })).toThrow('unknown field $.note');
  });

  it('rejects a malformed totp object and a null totp value', () => {
    expect(() => prepareWebuiAuthStateForRestore({ ...base, totp: { wrapSalt: 'zz' } }))
      .toThrow('totp wrapped secret fields are invalid');
    expect(() => prepareWebuiAuthStateForRestore({ ...base, totp: null }))
      .toThrow('totp state must be an object');
  });
});

describe('WebuiAuth', () => {
  const configPath = path.join('config', 'webui.json');
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-webui-auth-'));
    process.chdir(tmp);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  function readAuthFile(): Record<string, unknown> {
    return JSON.parse(fs.readFileSync(configPath, 'utf8')) as Record<string, unknown>;
  }

  function writeAuthFile(value: string | Record<string, unknown>): void {
    fs.mkdirSync('config', { recursive: true });
    fs.writeFileSync(configPath, typeof value === 'string' ? value : JSON.stringify(value, null, 2));
  }

  function backupNames(): string[] {
    if (!fs.existsSync('config')) return [];
    return fs.readdirSync('config').filter((name) => name.startsWith('webui.json.bak.')).sort();
  }

  it('publishes the fixed dev password', () => {
    expect(WebuiAuth.devPassword).toBe('snowluma-dev');
  });

  it('creates config/webui.json with a one-shot hex bootstrap password', () => {
    const auth = WebuiAuth.load();
    const initial = auth.takeInitialPassword();
    expect(initial).toMatch(/^[0-9a-f]{16}$/);
    expect(auth.takeInitialPassword()).toBeNull();
    expect(auth.mustChangePassword()).toBe(true);
    expect(auth.isDevMode()).toBe(false);
    expect(auth.verify(initial!)).toBe(true);
    expect(auth.verify('wrong-password')).toBe(false);
    expect(auth.verify('')).toBe(false);
    expect(auth.verify(undefined as unknown as string)).toBe(false);
    expect(auth.totpEnabled()).toBe(false);
    expect(auth.totpStatus()).toEqual({ enabled: false });
    expect(auth.totpState()).toBeUndefined();

    const disk = readAuthFile();
    expect(disk.mustChangePassword).toBe(true);
    expect(disk.totp).toBeUndefined();
    expect(disk.passwordHash).toMatch(/^[0-9a-f]{128}$/);
    expect(disk.passwordSalt).toMatch(/^[0-9a-f]{32}$/);
    expect(disk.generatedAt).toBe(disk.updatedAt);
    expect(Number.isFinite(Date.parse(disk.generatedAt as string))).toBe(true);
    if (process.platform !== 'win32') {
      expect(fs.statSync(configPath).mode & 0o777).toBe(0o600);
    }
  });

  it('rotates a leftover must-change bootstrap password on the next load', () => {
    const first = WebuiAuth.load();
    const oldPassword = first.takeInitialPassword();
    expect(oldPassword).toMatch(/^[0-9a-f]{16}$/);

    const second = WebuiAuth.load();
    const rotated = second.takeInitialPassword();
    expect(rotated).toMatch(/^[0-9a-f]{16}$/);
    expect(rotated).not.toBe(oldPassword);
    expect(second.mustChangePassword()).toBe(true);
    expect(second.verify(oldPassword!)).toBe(false);
    expect(second.verify(rotated!)).toBe(true);
  });

  it('seeds credentials from SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD when it is at least 8 characters', () => {
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = '12345678';
    const auth = WebuiAuth.load();
    expect(auth.takeInitialPassword()).toBeNull();
    expect(auth.mustChangePassword()).toBe(false);
    expect(auth.verify('12345678')).toBe(true);
    expect(readAuthFile().mustChangePassword).toBe(false);
  });

  it('ignores a bootstrap env value shorter than 8 characters', () => {
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = '1234567';
    const auth = WebuiAuth.load();
    expect(auth.mustChangePassword()).toBe(true);
    expect(auth.verify('1234567')).toBe(false);
    expect(auth.takeInitialPassword()).toMatch(/^[0-9a-f]{16}$/);
  });

  it('reloads an already-rotated file without regenerating', () => {
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = 'seed-pass';
    WebuiAuth.load();
    delete process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD;

    const again = WebuiAuth.load();
    expect(again.takeInitialPassword()).toBeNull();
    expect(again.mustChangePassword()).toBe(false);
    expect(again.verify('seed-pass')).toBe(true);
    expect(backupNames()).toEqual([]);
  });

  it('backs up invalid JSON and regenerates credentials', () => {
    writeAuthFile('{not-json');
    const auth = WebuiAuth.load();
    const names = backupNames();
    expect(names).toEqual([expect.stringMatching(/^webui\.json\.bak\.\d+$/)]);
    expect(fs.readFileSync(path.join('config', names[0]!), 'utf8')).toBe('{not-json');
    expect(auth.takeInitialPassword()).toMatch(/^[0-9a-f]{16}$/);
    expect(auth.mustChangePassword()).toBe(true);
  });

  it('backs up a schema-invalid object and can reseed from the bootstrap env', () => {
    writeAuthFile({ passwordHash: 'zz', passwordSalt: '00', mustChangePassword: false });
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = 'env-password';
    const auth = WebuiAuth.load();
    expect(backupNames()).toHaveLength(1);
    expect(auth.takeInitialPassword()).toBeNull();
    expect(auth.mustChangePassword()).toBe(false);
    expect(auth.verify('env-password')).toBe(true);
  });

  it('keeps password credentials when the live totp field is invalid', () => {
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = STRONG;
    WebuiAuth.load();
    delete process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD;

    const disk = readAuthFile();
    writeAuthFile({ ...disk, totp: { wrapSalt: 'zz' } });

    const auth = WebuiAuth.load();
    expect(auth.verify(STRONG)).toBe(true);
    expect(auth.mustChangePassword()).toBe(false);
    expect(auth.totpEnabled()).toBe(false);
    expect(auth.totpStatus()).toEqual({ enabled: false });
    expect(auth.totpState()).toBeUndefined();
    expect(backupNames()).toEqual([]);
  });

  it('loads a persisted totp object from disk', () => {
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = STRONG;
    const first = WebuiAuth.load();
    delete process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD;
    first.persistTotp(VALID_TOTP);

    const auth = WebuiAuth.load();
    expect(auth.totpEnabled()).toBe(true);
    expect(auth.totpStatus()).toEqual({
      enabled: true,
      remainingRecoveryCodes: 2,
      label: 'SnowLuma (testhost)',
    });
    expect(auth.totpState()).toEqual({
      wrapSalt: '11'.repeat(16),
      iv: '22'.repeat(12),
      ciphertext: '33'.repeat(10),
      authTag: '44'.repeat(16),
      recoveryCodeHashes: ['55'.repeat(32), '66'.repeat(32)],
      lastUsedStep: 7,
      label: 'SnowLuma (testhost)',
    });
  });

  it('setPassword writes a new hash, clears must-change, and keeps generatedAt', () => {
    const auth = WebuiAuth.load();
    const initial = auth.takeInitialPassword()!;
    const generatedAt = readAuthFile().generatedAt;

    expect(() => auth.setPassword('too-weak')).toThrow('密码不符合强度要求');
    auth.setPassword(STRONG);
    expect(auth.mustChangePassword()).toBe(false);
    expect(auth.verify(initial)).toBe(false);
    expect(auth.verify(STRONG)).toBe(true);

    const disk = readAuthFile();
    expect(disk.mustChangePassword).toBe(false);
    expect(disk.generatedAt).toBe(generatedAt);
    expect(disk.updatedAt).not.toBe(generatedAt);
    expect(disk.totp).toBeUndefined();
  });

  it('setPassword rewraps totp with the current password', () => {
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = STRONG;
    const auth = WebuiAuth.load();
    delete process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD;

    const enabled = confirmTotpEnrollment({
      password: STRONG,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    auth.persistTotp(enabled.state);

    expect(() => auth.setPassword(STRONG_NEXT)).toThrow('修改密码需要当前密码以重新保护 2FA 密钥');
    expect(() => auth.setPassword(STRONG_NEXT, '')).toThrow('修改密码需要当前密码以重新保护 2FA 密钥');
    expect(() => auth.setPassword(STRONG_NEXT, 'Wrong-Password-3!')).toThrow('无法使用当前密码解开 2FA 密钥');

    auth.setPassword(STRONG_NEXT, STRONG);
    expect(auth.verify(STRONG)).toBe(false);
    expect(auth.verify(STRONG_NEXT)).toBe(true);
    expect(auth.totpEnabled()).toBe(true);
    expect(unwrapTotpSecret(STRONG_NEXT, auth.totpState()!)).toBe(RFC_SECRET);
    expect(unwrapTotpSecret(STRONG, auth.totpState()!)).toBeNull();
  });

  it('persistTotp writes, reports, and then removes 2FA state', () => {
    process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD = STRONG;
    const auth = WebuiAuth.load();
    delete process.env.SNOWLUMA_WEBUI_BOOTSTRAP_PASSWORD;

    auth.persistTotp(VALID_TOTP);
    expect(auth.totpEnabled()).toBe(true);
    expect(auth.totpStatus()).toEqual({
      enabled: true,
      remainingRecoveryCodes: 2,
      label: 'SnowLuma (testhost)',
    });
    expect(auth.totpState()).toEqual(VALID_TOTP);
    expect(readAuthFile().totp).toEqual(VALID_TOTP);

    auth.persistTotp(undefined);
    expect(auth.totpEnabled()).toBe(false);
    expect(auth.totpStatus()).toEqual({ enabled: false });
    expect(auth.totpState()).toBeUndefined();
    expect(Object.prototype.hasOwnProperty.call(readAuthFile(), 'totp')).toBe(false);
  });

  it('uses the in-memory dev password and never reads or writes webui.json', () => {
    writeAuthFile('should-not-be-read');
    process.env.SNOWLUMA_DEV_MODE = '1';
    const auth = WebuiAuth.load();
    delete process.env.SNOWLUMA_DEV_MODE;

    expect(isDevAuthMode()).toBe(false);
    expect(auth.isDevMode()).toBe(true);
    expect(auth.mustChangePassword()).toBe(false);
    expect(auth.takeInitialPassword()).toBeNull();
    expect(auth.verify('snowluma-dev')).toBe(true);
    expect(auth.verify(STRONG)).toBe(false);
    expect(auth.totpEnabled()).toBe(false);
    expect(() => auth.setPassword(STRONG)).toThrow('开发模式 (SNOWLUMA_DEV_MODE=1) 已禁用密码修改');
    expect(() => auth.persistTotp(VALID_TOTP)).toThrow('开发模式 (SNOWLUMA_DEV_MODE=1) 已禁用 2FA');
    expect(fs.readFileSync(configPath, 'utf8')).toBe('should-not-be-read');
  });

  it('does not create config/webui.json when loading in dev mode on a fresh directory', () => {
    process.env.SNOWLUMA_DEV_MODE = '1';
    WebuiAuth.load();
    expect(fs.existsSync('config')).toBe(false);
  });
});
