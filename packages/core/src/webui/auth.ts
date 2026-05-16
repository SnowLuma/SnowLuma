import fs from 'fs';
import path from 'path';
import { randomBytes, scryptSync, timingSafeEqual } from 'crypto';
import { createLogger } from '../utils/logger';

const log = createLogger('WebUI.Auth');

const CONFIG_DIR = 'config';
const WEBUI_CONFIG_PATH = path.join(CONFIG_DIR, 'webui.json');

const SCRYPT_KEYLEN = 64;
const SCRYPT_N = 16384; // cost
const SCRYPT_R = 8;
const SCRYPT_P = 1;

/**
 * Fixed credentials used when SNOWLUMA_DEV_MODE=1 is set. The state is kept
 * entirely in memory and never written to `config/webui.json`, so toggling
 * dev mode on/off never disturbs the real persisted password.
 */
const DEV_PASSWORD = 'snowluma-dev';

export function isDevAuthMode(): boolean {
  return process.env.SNOWLUMA_DEV_MODE === '1';
}

export interface WebuiAuthState {
  passwordHash: string; // hex
  passwordSalt: string; // hex
  mustChangePassword: boolean;
  generatedAt: string;
  updatedAt: string;
}

export interface PasswordRule {
  id: string;
  label: string;
  test: (pwd: string) => boolean;
}

export const PASSWORD_RULES: PasswordRule[] = [
  { id: 'length', label: '长度不少于 10 位', test: (p) => p.length >= 10 },
  { id: 'lower', label: '包含小写字母', test: (p) => /[a-z]/.test(p) },
  { id: 'upper', label: '包含大写字母', test: (p) => /[A-Z]/.test(p) },
  { id: 'special', label: '包含特殊符号 (!@#$%…)', test: (p) => /[^A-Za-z0-9\s]/.test(p) },
  { id: 'no-space', label: '不包含空格', test: (p) => !/\s/.test(p) && p.length > 0 },
];

export function evaluatePasswordRules(password: string): { id: string; label: string; ok: boolean }[] {
  return PASSWORD_RULES.map((r) => ({ id: r.id, label: r.label, ok: r.test(password) }));
}

export function isStrongPassword(password: string): boolean {
  return PASSWORD_RULES.every((r) => r.test(password));
}

function hashPassword(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, SCRYPT_KEYLEN, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function isValidState(value: unknown): value is WebuiAuthState {
  if (!value || typeof value !== 'object') return false;
  const v = value as Record<string, unknown>;
  return (
    typeof v.passwordHash === 'string' &&
    typeof v.passwordSalt === 'string' &&
    typeof v.mustChangePassword === 'boolean' &&
    /^[0-9a-f]+$/i.test(v.passwordHash) &&
    /^[0-9a-f]+$/i.test(v.passwordSalt)
  );
}

function generateInitialState(initialPassword: string): WebuiAuthState {
  const salt = randomBytes(16);
  const hash = hashPassword(initialPassword, salt);
  const now = new Date().toISOString();
  return {
    passwordHash: hash.toString('hex'),
    passwordSalt: salt.toString('hex'),
    mustChangePassword: true,
    generatedAt: now,
    updatedAt: now,
  };
}

function backupCorruptConfig(): void {
  try {
    const dest = `${WEBUI_CONFIG_PATH}.bak.${Date.now()}`;
    fs.renameSync(WEBUI_CONFIG_PATH, dest);
    log.warn('previous webui.json moved to %s', dest);
  } catch (err) {
    log.warn('failed to back up corrupt webui.json: %s', err instanceof Error ? err.message : String(err));
  }
}

function atomicWrite(state: WebuiAuthState): void {
  ensureConfigDir();
  const tmp = WEBUI_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2), { encoding: 'utf8', mode: 0o600 });
  // chmod again in case the file already existed with looser perms
  try {
    fs.chmodSync(tmp, 0o600);
  } catch {
    /* ignore */
  }
  fs.renameSync(tmp, WEBUI_CONFIG_PATH);
}

export class WebuiAuth {
  private state: WebuiAuthState;
  private initialPlain: string | null;
  private readonly devMode: boolean;

  private constructor(state: WebuiAuthState, initialPlain: string | null, devMode: boolean) {
    this.state = state;
    this.initialPlain = initialPlain;
    this.devMode = devMode;
  }

  static load(): WebuiAuth {
    if (isDevAuthMode()) {
      const salt = randomBytes(16);
      const hash = hashPassword(DEV_PASSWORD, salt);
      const now = new Date().toISOString();
      const state: WebuiAuthState = {
        passwordHash: hash.toString('hex'),
        passwordSalt: salt.toString('hex'),
        mustChangePassword: false,
        generatedAt: now,
        updatedAt: now,
      };
      return new WebuiAuth(state, null, true);
    }
    ensureConfigDir();
    if (fs.existsSync(WEBUI_CONFIG_PATH)) {
      try {
        const raw = fs.readFileSync(WEBUI_CONFIG_PATH, 'utf8');
        const parsed = JSON.parse(raw) as unknown;
        if (isValidState(parsed)) {
          return new WebuiAuth(parsed, null, false);
        }
        log.error('webui.json schema invalid; backing up and regenerating credentials');
        backupCorruptConfig();
      } catch (err) {
        log.error(
          'webui.json is corrupt and will be regenerated; the previous file is backed up: %s',
          err instanceof Error ? err.message : String(err),
        );
        backupCorruptConfig();
      }
    }
    const initialPassword = randomBytes(8).toString('hex');
    const state = generateInitialState(initialPassword);
    atomicWrite(state);
    return new WebuiAuth(state, initialPassword, false);
  }

  /** True when SNOWLUMA_DEV_MODE was active at load time. */
  isDevMode(): boolean {
    return this.devMode;
  }

  /** Fixed dev password (only meaningful when {@link isDevMode} is true). */
  static get devPassword(): string {
    return DEV_PASSWORD;
  }

  /** Returns the auto-generated initial password if this is a fresh install, else null. */
  takeInitialPassword(): string | null {
    const p = this.initialPlain;
    this.initialPlain = null;
    return p;
  }

  mustChangePassword(): boolean {
    return this.state.mustChangePassword;
  }

  verify(password: string): boolean {
    if (typeof password !== 'string' || password.length === 0) return false;
    try {
      const salt = Buffer.from(this.state.passwordSalt, 'hex');
      const expected = Buffer.from(this.state.passwordHash, 'hex');
      const got = hashPassword(password, salt);
      if (got.length !== expected.length) return false;
      return timingSafeEqual(got, expected);
    } catch {
      return false;
    }
  }

  /**
   * Update password atomically. Throws if the new password fails strength rules.
   * After success, mustChangePassword=false and the file is rewritten on disk.
   */
  setPassword(newPassword: string): void {
    if (this.devMode) {
      throw new Error('开发模式 (SNOWLUMA_DEV_MODE=1) 已禁用密码修改');
    }
    if (!isStrongPassword(newPassword)) {
      throw new Error('密码不符合强度要求');
    }
    const salt = randomBytes(16);
    const hash = hashPassword(newPassword, salt);
    const next: WebuiAuthState = {
      passwordHash: hash.toString('hex'),
      passwordSalt: salt.toString('hex'),
      mustChangePassword: false,
      generatedAt: this.state.generatedAt,
      updatedAt: new Date().toISOString(),
    };
    atomicWrite(next);
    this.state = next;
  }
}
