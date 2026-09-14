import { createCipheriv, createDecipheriv, createHash, randomBytes, scryptSync, timingSafeEqual } from 'node:crypto';
import * as OTPAuth from 'otpauth';

const TOTP_PERIOD_SECONDS = 30;
const TOTP_WINDOW = 1;
const TOTP_DIGITS = 6;
const RECOVERY_CODE_COUNT = 8;
const RECOVERY_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const WRAP_SALT_BYTES = 16;
const WRAP_IV_BYTES = 12;
const WRAP_KEY_BYTES = 32;
const SCRYPT_N = 16384;
const SCRYPT_R = 8;
const SCRYPT_P = 1;

export interface WrappedTotpSecret {
  wrapSalt: string;
  iv: string;
  ciphertext: string;
  authTag: string;
}

export interface TotpPersistedState extends WrappedTotpSecret {
  recoveryCodeHashes: string[];
  lastUsedStep: number;
  label: string;
}

export interface TotpEnrollment {
  secret: string;
  otpauthUrl: string;
  issuer: string;
  accountName: string;
}

function totpFromSecret(secretBase32: string, issuer = '', accountName = 'admin'): OTPAuth.TOTP {
  return new OTPAuth.TOTP({
    issuer,
    label: accountName,
    algorithm: 'SHA1',
    digits: TOTP_DIGITS,
    period: TOTP_PERIOD_SECONDS,
    secret: OTPAuth.Secret.fromBase32(secretBase32),
  });
}

export function verifyTotpCode(
  secretBase32: string,
  code: string,
  atMs: number,
  lastUsedStep?: number,
): { ok: true; step: number } | { ok: false } {
  const token = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(token)) return { ok: false };

  let totp: OTPAuth.TOTP;
  try {
    totp = totpFromSecret(secretBase32);
  } catch {
    return { ok: false };
  }
  const delta = totp.validate({ token, timestamp: atMs, window: TOTP_WINDOW });
  if (delta === null) return { ok: false };

  const step = totp.counter({ timestamp: atMs }) + delta;
  if (lastUsedStep !== undefined && step === lastUsedStep) return { ok: false };
  return { ok: true, step };
}

function deriveWrapKey(password: string, salt: Buffer): Buffer {
  return scryptSync(password, salt, WRAP_KEY_BYTES, { N: SCRYPT_N, r: SCRYPT_R, p: SCRYPT_P });
}

export function wrapTotpSecret(password: string, secret: string): WrappedTotpSecret {
  const wrapSalt = randomBytes(WRAP_SALT_BYTES);
  const iv = randomBytes(WRAP_IV_BYTES);
  const key = deriveWrapKey(password, wrapSalt);
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return {
    wrapSalt: wrapSalt.toString('hex'),
    iv: iv.toString('hex'),
    ciphertext: ciphertext.toString('hex'),
    authTag: cipher.getAuthTag().toString('hex'),
  };
}

export function unwrapTotpSecret(password: string, wrapped: WrappedTotpSecret): string | null {
  try {
    const wrapSalt = Buffer.from(wrapped.wrapSalt, 'hex');
    const iv = Buffer.from(wrapped.iv, 'hex');
    const ciphertext = Buffer.from(wrapped.ciphertext, 'hex');
    const authTag = Buffer.from(wrapped.authTag, 'hex');
    if (wrapSalt.length !== WRAP_SALT_BYTES || iv.length !== WRAP_IV_BYTES || authTag.length !== 16) {
      return null;
    }
    const key = deriveWrapKey(password, wrapSalt);
    const decipher = createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(authTag);
    return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString('utf8');
  } catch {
    return null;
  }
}

function randomRecoveryChunk(): string {
  const bytes = randomBytes(4);
  let chunk = '';
  for (let i = 0; i < 4; i++) {
    chunk += RECOVERY_ALPHABET[bytes[i]! % RECOVERY_ALPHABET.length];
  }
  return chunk;
}

export function generateRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    codes.add(`${randomRecoveryChunk()}-${randomRecoveryChunk()}`);
  }
  return [...codes];
}

export function normalizeRecoveryCode(code: string): string {
  return code.replace(/[-\s]/g, '').toUpperCase();
}

export function hashRecoveryCode(code: string): string {
  return createHash('sha256').update(normalizeRecoveryCode(code), 'utf8').digest('hex');
}

function hashesEqual(left: string, right: string): boolean {
  const a = Buffer.from(left, 'hex');
  const b = Buffer.from(right, 'hex');
  if (a.length !== b.length || a.length === 0) return false;
  return timingSafeEqual(a, b);
}

export function consumeRecoveryCode(
  code: string,
  hashes: readonly string[],
): { ok: true; remainingHashes: string[] } | { ok: false } {
  const candidate = hashRecoveryCode(code);
  const index = hashes.findIndex((hash) => hashesEqual(hash, candidate));
  if (index < 0) return { ok: false };
  return { ok: true, remainingHashes: hashes.filter((_, i) => i !== index) };
}

export function beginTotpEnrollment(options: {
  issuer: string;
  accountName: string;
  secret?: string;
}): TotpEnrollment {
  const secret = options.secret ?? new OTPAuth.Secret({ size: 20 }).base32;
  const totp = totpFromSecret(secret, options.issuer, options.accountName);
  return {
    secret,
    otpauthUrl: totp.toString(),
    issuer: options.issuer,
    accountName: options.accountName,
  };
}

export function confirmTotpEnrollment(options: {
  password: string;
  secret: string;
  code: string;
  label: string;
  atMs: number;
}): { state: TotpPersistedState; recoveryCodes: string[] } {
  const verified = verifyTotpCode(options.secret, options.code, options.atMs);
  if (!verified.ok) {
    throw new Error('验证码不正确');
  }
  const recoveryCodes = generateRecoveryCodes();
  return {
    recoveryCodes,
    state: {
      ...wrapTotpSecret(options.password, options.secret),
      recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
      lastUsedStep: verified.step,
      label: options.label,
    },
  };
}

export function verifySecondFactor(options: {
  password: string;
  state: TotpPersistedState;
  atMs: number;
  totp?: string;
  recoveryCode?: string;
}): { ok: true; state: TotpPersistedState } | { ok: false } {
  if (typeof options.recoveryCode === 'string' && options.recoveryCode.length > 0) {
    const consumed = consumeRecoveryCode(options.recoveryCode, options.state.recoveryCodeHashes);
    if (!consumed.ok) return { ok: false };
    return { ok: true, state: { ...options.state, recoveryCodeHashes: consumed.remainingHashes } };
  }
  if (typeof options.totp !== 'string') return { ok: false };
  const secret = unwrapTotpSecret(options.password, options.state);
  if (secret === null) return { ok: false };
  const checked = verifyTotpCode(secret, options.totp, options.atMs, options.state.lastUsedStep);
  if (!checked.ok) return { ok: false };
  return { ok: true, state: { ...options.state, lastUsedStep: checked.step } };
}

export type SecondFactorDecision =
  | { kind: 'needs-totp' }
  | { kind: 'bad-second-factor' }
  | { kind: 'ok'; state?: TotpPersistedState };

export function decideSecondFactorLogin(options: {
  totpEnabled: boolean;
  state?: TotpPersistedState;
  password: string;
  totp?: string;
  recoveryCode?: string;
  atMs: number;
}): SecondFactorDecision {
  if (!options.totpEnabled) return { kind: 'ok' };
  if (!options.state) return { kind: 'bad-second-factor' };
  const totp = typeof options.totp === 'string' && options.totp.trim().length > 0
    ? options.totp.trim()
    : undefined;
  const recoveryCode = typeof options.recoveryCode === 'string' && options.recoveryCode.trim().length > 0
    ? options.recoveryCode.trim()
    : undefined;
  if (!totp && !recoveryCode) return { kind: 'needs-totp' };
  const result = verifySecondFactor({
    password: options.password,
    state: options.state,
    atMs: options.atMs,
    totp,
    recoveryCode,
  });
  if (!result.ok) return { kind: 'bad-second-factor' };
  return { kind: 'ok', state: result.state };
}

export function regenerateRecoveryCodes(options: {
  password: string;
  state: TotpPersistedState;
  totp: string;
  atMs: number;
}): { state: TotpPersistedState; recoveryCodes: string[] } {
  const verified = verifySecondFactor({
    password: options.password,
    state: options.state,
    totp: options.totp,
    atMs: options.atMs,
  });
  if (!verified.ok) {
    throw new Error('验证码不正确');
  }
  const recoveryCodes = generateRecoveryCodes();
  return {
    recoveryCodes,
    state: {
      ...verified.state,
      recoveryCodeHashes: recoveryCodes.map(hashRecoveryCode),
    },
  };
}

export function rewrapTotpSecret(
  oldPassword: string,
  newPassword: string,
  state: TotpPersistedState,
): TotpPersistedState {
  const secret = unwrapTotpSecret(oldPassword, state);
  if (secret === null) {
    throw new Error('无法使用当前密码解开 2FA 密钥');
  }
  return {
    ...state,
    ...wrapTotpSecret(newPassword, secret),
  };
}

const HEX = /^[0-9a-f]+$/i;

function isWrappedShape(value: Record<string, unknown>): value is WrappedTotpSecret & Record<string, unknown> {
  return typeof value.wrapSalt === 'string'
    && HEX.test(value.wrapSalt)
    && value.wrapSalt.length === WRAP_SALT_BYTES * 2
    && typeof value.iv === 'string'
    && HEX.test(value.iv)
    && value.iv.length === WRAP_IV_BYTES * 2
    && typeof value.ciphertext === 'string'
    && HEX.test(value.ciphertext)
    && value.ciphertext.length > 0
    && value.ciphertext.length % 2 === 0
    && typeof value.authTag === 'string'
    && HEX.test(value.authTag)
    && value.authTag.length === 32;
}

export function prepareTotpStateForRestore(value: unknown): TotpPersistedState {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('totp state must be an object');
  }
  const v = value as Record<string, unknown>;
  if (!isWrappedShape(v)) {
    throw new Error('totp wrapped secret fields are invalid');
  }
  if (!Array.isArray(v.recoveryCodeHashes)
    || v.recoveryCodeHashes.length > RECOVERY_CODE_COUNT
    || v.recoveryCodeHashes.some((hash) => typeof hash !== 'string' || !/^[0-9a-f]{64}$/i.test(hash))) {
    throw new Error('totp recoveryCodeHashes must be SHA-256 hex strings');
  }
  if (typeof v.lastUsedStep !== 'number' || !Number.isInteger(v.lastUsedStep) || v.lastUsedStep < 0) {
    throw new Error('totp lastUsedStep must be a non-negative integer');
  }
  if (typeof v.label !== 'string' || v.label.length === 0 || v.label.length > 128) {
    throw new Error('totp label must be a non-empty string');
  }
  const allowed = new Set(['wrapSalt', 'iv', 'ciphertext', 'authTag', 'recoveryCodeHashes', 'lastUsedStep', 'label']);
  const unknown = Object.keys(v).find((key) => !allowed.has(key));
  if (unknown) throw new Error(`unknown totp field $.${unknown}`);
  return {
    wrapSalt: v.wrapSalt.toLowerCase(),
    iv: v.iv.toLowerCase(),
    ciphertext: v.ciphertext.toLowerCase(),
    authTag: v.authTag.toLowerCase(),
    recoveryCodeHashes: v.recoveryCodeHashes.map((hash) => (hash as string).toLowerCase()),
    lastUsedStep: v.lastUsedStep,
    label: v.label,
  };
}

export function parseTotpStateLenient(value: unknown): TotpPersistedState | undefined {
  if (value === undefined || value === null) return undefined;
  try {
    return prepareTotpStateForRestore(value);
  } catch {
    return undefined;
  }
}
