// WebUI config backup/restore (Wave A2). Format: a zero-dep JSON bundle
//   { version, app, createdAt, files: { "<name>": { encoding, data } } }
// over an explicit allowlist (never a whole-dir sweep) so a stray/unknown file
// can't leak and an import can't path-traverse.
//
// Credentials are gated by a toggle on both export and import. The credential
// set is: webui.json (password hash), key.pem (TLS private key),
// notifications.json (webhook URLs may embed secrets), AND every OneBot config
// (onebot.json + per-account onebot_<uin>.json) — those carry access tokens, so
// a no-credentials backup must NOT include them.
// cert.pem is public so it always travels.
//
// Pure functions here own bundle validation and semantic preflight. Filesystem
// transaction choreography lives in restore.ts. A non-empty restore remains
// restart-to-apply, like A1.

import { normalizeRuntimeConfig } from '@snowluma/common/runtime';
import { isRealUin } from '@snowluma/common/uin';
import { normalizeGlobalSettings } from '@snowluma/onebot/global-config';
import { prepareOneBotConfigForRestore } from '@snowluma/onebot/config';
import { isIP } from 'node:net';
import { normalizeNotificationsConfig } from '../notifications/config';
import { prepareWebuiAuthStateForRestore } from './auth';
import { MAX_BACKGROUND_BYTES, normalizeStoredUiConfig, sniffImageMime } from './ui-config';
import { validateTlsPair } from './tls';

export const BACKUP_VERSION = 1;
export const BACKUP_APP = 'snowluma';
export const MAX_BACKUP_DECODED_BYTES = 32 * 1024 * 1024;

export interface BackupFileSpec {
  /** Path relative to the config dir; also the bundle key. */
  name: string;
  binary: boolean;
  /** Sensitive (private key / password hash / access token) — credential-gated. */
  credential: boolean;
}

/** Static allowlist. Per-account `onebot_<uin>.json` are matched by pattern. */
export const BACKUP_FILES: readonly BackupFileSpec[] = [
  { name: 'runtime.json', binary: false, credential: false },
  { name: 'ui.json', binary: false, credential: false },
  { name: 'notifications.json', binary: false, credential: true },
  // Global all-accounts SnowLuma settings (rkey fallback servers, …).
  { name: 'snowluma.json', binary: false, credential: false },
  { name: 'cert.pem', binary: false, credential: false },
  { name: 'ui-assets/background', binary: true, credential: false },
  { name: 'webui.json', binary: false, credential: true },
  { name: 'key.pem', binary: false, credential: true },
  // OneBot config carries the access token → credential.
  { name: 'onebot.json', binary: false, credential: true },
];

const SPEC_BY_NAME = new Map(BACKUP_FILES.map((f) => [f.name, f]));
const PER_UIN_ONEBOT = /^onebot_(\d+)\.json$/;

function isPerUinOneBotName(name: string): boolean {
  const match = PER_UIN_ONEBOT.exec(name);
  return match !== null && isRealUin(match[1]);
}

/** Resolve a file name (static or per-uin onebot pattern) to its spec, or null. */
export function specFor(name: string): BackupFileSpec | null {
  const s = SPEC_BY_NAME.get(name);
  if (s) return s;
  if (isPerUinOneBotName(name)) return { name, binary: false, credential: true };
  return null;
}

export interface BackupEntry { encoding: 'utf8' | 'base64'; data: string }
export interface Backup {
  version: number;
  app: string;
  createdAt?: string;
  files: Record<string, BackupEntry>;
}

/**
 * Assemble a bundle from the allowlist plus any per-account onebot files.
 * `readFile` returns null for missing.
 */
export function buildBackup(
  readFile: (name: string) => Buffer | null,
  perUinOnebotNames: readonly string[],
  opts: { includeCredentials: boolean },
  createdAt: string,
): Backup {
  const files: Record<string, BackupEntry> = {};
  const all: BackupFileSpec[] = [
    ...BACKUP_FILES,
    ...perUinOnebotNames.filter(isPerUinOneBotName).map((n) => ({ name: n, binary: false, credential: true })),
  ];
  for (const spec of all) {
    if (spec.credential && !opts.includeCredentials) continue;
    const buf = readFile(spec.name);
    if (!buf) continue;
    files[spec.name] = spec.binary
      ? { encoding: 'base64', data: buf.toString('base64') }
      : { encoding: 'utf8', data: buf.toString('utf8') };
  }
  return { version: BACKUP_VERSION, app: BACKUP_APP, createdAt, files };
}

function validateBackupEntries(
  parsed: unknown,
  skipEntryValidation: (spec: BackupFileSpec) => boolean,
): { ok: true; backup: Backup } | { ok: false; error: string } {
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { ok: false, error: 'backup must be an object' };
  }
  const b = parsed as Record<string, unknown>;
  if (b.app !== BACKUP_APP) return { ok: false, error: 'not a SnowLuma backup' };
  if (b.version !== BACKUP_VERSION) return { ok: false, error: `unsupported backup version ${String(b.version)}` };
  if (typeof b.files !== 'object' || b.files === null || Array.isArray(b.files)) {
    return { ok: false, error: 'backup.files must be an object' };
  }
  const files = b.files as Record<string, unknown>;
  for (const [name, entry] of Object.entries(files)) {
    const spec = specFor(name);
    if (!spec) return { ok: false, error: `unknown file in backup: ${name}` };
    if (skipEntryValidation(spec)) continue;
    if (typeof entry !== 'object' || entry === null) return { ok: false, error: `malformed entry: ${name}` };
    const e = entry as Record<string, unknown>;
    if (e.encoding !== 'utf8' && e.encoding !== 'base64') return { ok: false, error: `bad encoding for ${name}` };
    if (typeof e.data !== 'string') return { ok: false, error: `bad data for ${name}` };
  }
  return { ok: true, backup: { version: BACKUP_VERSION, app: BACKUP_APP, createdAt: typeof b.createdAt === 'string' ? b.createdAt : undefined, files: files as Record<string, BackupEntry> } };
}

export interface PreparedRestoreFile {
  name: string;
  data: Buffer;
  mode: 0o600 | 0o644;
}

export interface RestoreMigration {
  name: string;
  fields: string[];
}

export interface PreparedRestorePlan {
  restore: PreparedRestoreFile[];
  skipped: string[];
  migrated: RestoreMigration[];
}

export interface PrepareRestoreOptions {
  restoreCredentials: boolean;
  /** Read an existing live file for overlay-wide validation (TLS/UI). */
  readCurrent: (name: string) => Buffer | null;
  /** Current per-account configs affected when onebot.json is replaced. */
  listCurrentOneBotNames?: () => string[];
}

export class RestorePreflightError extends Error {
  readonly file: string;

  constructor(file: string, message: string, options?: { cause?: unknown }) {
    super(`${file}: ${message}`, options);
    this.name = 'RestorePreflightError';
    this.file = file;
  }
}

/**
 * Validate every selected file semantically and materialize canonical bytes
 * before the transaction is allowed to touch live configuration.
 */
export function prepareRestorePlan(parsed: unknown, opts: PrepareRestoreOptions): PreparedRestorePlan {
  const checked = validateBackupEntries(parsed, (spec) => spec.credential && !opts.restoreCredentials);
  if (!checked.ok) throw new RestorePreflightError('<backup>', checked.error);

  const restore: PreparedRestoreFile[] = [];
  const skipped: string[] = [];
  const migrated: RestoreMigration[] = [];
  const selected: Array<{ name: string; data: Buffer; spec: BackupFileSpec }> = [];
  let decodedBytes = 0;

  for (const [name, entry] of Object.entries(checked.backup.files)) {
    const spec = specFor(name);
    if (!spec) throw new RestorePreflightError(name, 'file is not in the restore allowlist');
    if (spec.credential && !opts.restoreCredentials) {
      skipped.push(name);
      continue;
    }
    if (entry.encoding !== (spec.binary ? 'base64' : 'utf8')) {
      throw new RestorePreflightError(name, `encoding must be ${spec.binary ? 'base64' : 'utf8'}`);
    }

    const decoded = decodeEntryStrict(name, entry);
    decodedBytes += decoded.length;
    if (decodedBytes > MAX_BACKUP_DECODED_BYTES) {
      throw new RestorePreflightError(name, `selected files exceed ${String(MAX_BACKUP_DECODED_BYTES)} decoded bytes`);
    }

    selected.push({ name, data: decoded, spec });
  }

  const selectedGlobal = selected.find((file) => file.name === 'onebot.json');
  const selectedPerUin = selected.filter((file) => isPerUinOneBotName(file.name));
  const selectedPerUinRaw = new Map(selectedPerUin.map((file) => [file.name, parseJson(file.name, file.data)]));
  const perUinNeedsGlobal = [...selectedPerUinRaw.values()].some((raw) => !isPlainObject(raw) || raw.mode !== 'snapshot');
  let effectiveGlobalOneBot: unknown;
  let preparedGlobalOneBot: ReturnType<typeof prepareOneBotConfigForRestore> | null = null;
  if (selectedGlobal) {
    if (!opts.listCurrentOneBotNames) {
      throw new RestorePreflightError('onebot.json', 'current per-account config listing is required to validate the effective overlay');
    }
    const raw = parseJson(selectedGlobal.name, selectedGlobal.data);
    preparedGlobalOneBot = prepareOneBotOrThrow(selectedGlobal.name, raw, 'global');
    effectiveGlobalOneBot = preparedGlobalOneBot.value;
  } else if (perUinNeedsGlobal) {
    const current = readCurrentForPreflight(opts, 'onebot.json');
    if (current) {
      const raw = parseJson('onebot.json', current);
      effectiveGlobalOneBot = prepareOneBotOrThrow('onebot.json', raw, 'global').value;
    }
  }

  for (const { name, data, spec } of selected) {
    let prepared: { data: Buffer; migratedFields: string[] };
    if (name === 'onebot.json') {
      const global = preparedGlobalOneBot!;
      prepared = { data: serializeJson(global.value), migratedFields: global.migratedFields };
    } else if (isPerUinOneBotName(name)) {
      const raw = selectedPerUinRaw.get(name);
      const onebot = prepareOneBotOrThrow(name, raw, 'per-uin', effectiveGlobalOneBot);
      prepared = { data: serializeJson(onebot.value), migratedFields: onebot.migratedFields };
    } else {
      prepared = prepareFile(name, data);
    }
    restore.push({ name, data: prepared.data, mode: spec.credential ? 0o600 : 0o644 });
    if (prepared.migratedFields.length > 0) {
      migrated.push({ name, fields: [...prepared.migratedFields].sort() });
    }
  }

  if (selectedGlobal) {
    const selectedNames = new Set(selected.map((file) => file.name));
    let currentNames: string[];
    try {
      currentNames = opts.listCurrentOneBotNames!();
    } catch (error) {
      throw new RestorePreflightError('onebot.json', `failed to list current per-account configs: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
    for (const name of currentNames) {
      if (!isPerUinOneBotName(name) || selectedNames.has(name)) continue;
      const current = readCurrentForPreflight(opts, name);
      if (!current) continue;
      const raw = parseJson(name, current);
      prepareOneBotOrThrow(name, raw, 'per-uin', effectiveGlobalOneBot);
    }
  }

  validateEffectiveTls(restore, opts);
  validateEffectiveUi(restore, opts);
  return { restore, skipped, migrated };
}

function decodeEntryStrict(name: string, entry: BackupEntry): Buffer {
  if (entry.encoding === 'utf8') return Buffer.from(entry.data, 'utf8');
  if (!isCanonicalBase64(entry.data)) {
    throw new RestorePreflightError(name, 'data is not canonical base64');
  }
  return Buffer.from(entry.data, 'base64');
}

function isCanonicalBase64(value: string): boolean {
  if (value.length === 0) return true;
  if (value.length % 4 !== 0 || !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(value)) {
    return false;
  }
  return Buffer.from(value, 'base64').toString('base64') === value;
}

function prepareFile(name: string, data: Buffer): { data: Buffer; migratedFields: string[] } {
  try {
    switch (name) {
      case 'runtime.json':
        return prepareRuntimeJson(name, data);
      case 'ui.json':
        return prepareNormalizedJson(name, data, normalizeStoredUiConfig);
      case 'notifications.json':
        return prepareNormalizedJson(name, data, normalizeNotificationsConfig);
      case 'snowluma.json':
        return prepareGlobalSettingsJson(name, data);
      case 'webui.json': {
        const value = parseJson(name, data);
        const canonical = prepareWebuiAuthStateForRestore(value);
        return { data: serializeJson(canonical), migratedFields: [] };
      }
      case 'ui-assets/background':
        if (data.length > MAX_BACKGROUND_BYTES) {
          throw new Error(`image exceeds ${String(MAX_BACKGROUND_BYTES)} bytes`);
        }
        if (!sniffImageMime(data)) throw new Error('image must be PNG, JPEG, or WebP');
        return { data, migratedFields: [] };
      case 'cert.pem':
      case 'key.pem':
        if (!data.toString('utf8').trim()) throw new Error('PEM file must not be empty');
        return { data, migratedFields: [] };
      default:
        throw new Error('file is not in the restore allowlist');
    }
  } catch (error) {
    if (error instanceof RestorePreflightError) throw error;
    throw new RestorePreflightError(name, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function prepareOneBotOrThrow(
  name: string,
  value: unknown,
  scope: 'global' | 'per-uin',
  inheritedGlobal?: unknown,
): ReturnType<typeof prepareOneBotConfigForRestore> {
  try {
    return prepareOneBotConfigForRestore(value, scope, inheritedGlobal);
  } catch (error) {
    throw new RestorePreflightError(name, error instanceof Error ? error.message : String(error), { cause: error });
  }
}

function readCurrentForPreflight(opts: PrepareRestoreOptions, name: string): Buffer | null {
  try {
    return opts.readCurrent(name);
  } catch (error) {
    throw new RestorePreflightError(name, `failed to read current file: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
}

function parseJson(name: string, data: Buffer): unknown {
  try {
    return JSON.parse(data.toString('utf8')) as unknown;
  } catch (error) {
    // V8 may quote the offending input in SyntaxError.message. Some restored
    // JSON files contain credentials, so expose only a fixed diagnostic while
    // retaining the original exception as the in-process cause.
    throw new RestorePreflightError(name, 'invalid JSON', { cause: error });
  }
}

function prepareNormalizedJson<T>(name: string, data: Buffer, normalize: (value: unknown) => T): {
  data: Buffer;
  migratedFields: string[];
} {
  const raw = parseJson(name, data);
  const canonical = normalize(raw);
  const migratedFields: string[] = [];
  assertNoLossyNormalization(name, raw, canonical, '$', migratedFields);
  return { data: serializeJson(canonical), migratedFields };
}

function prepareRuntimeJson(name: string, data: Buffer): {
  data: Buffer;
  migratedFields: string[];
} {
  const prepared = prepareNormalizedJson(name, data, normalizeRuntimeConfig);
  const runtime = JSON.parse(prepared.data.toString('utf8')) as ReturnType<typeof normalizeRuntimeConfig>;
  if (!runtime.webuiHost || !isValidBindHost(runtime.webuiHost)) {
    throw new RestorePreflightError(name, '$.webuiHost is not a valid TCP bind host');
  }
  return prepared;
}

function prepareGlobalSettingsJson(name: string, data: Buffer): {
  data: Buffer;
  migratedFields: string[];
} {
  const raw = parseJson(name, data);
  const normalized = normalizeGlobalSettings(raw);
  const canonical: Record<string, unknown> = { rkey: normalized.rkey };
  // Missing is the existing one-shot migration sentinel: startup scans legacy
  // onebot*.json only until snowluma.json first carries this key.
  if (isPlainObject(raw) && Object.prototype.hasOwnProperty.call(raw, 'musicSignUrl')) {
    canonical.musicSignUrl = normalized.musicSignUrl;
  }
  const migratedFields: string[] = [];
  assertNoLossyNormalization(name, raw, canonical, '$', migratedFields);
  return { data: serializeJson(canonical), migratedFields };
}

function assertNoLossyNormalization(
  name: string,
  raw: unknown,
  canonical: unknown,
  at: string,
  additions: string[],
): void {
  if (isPlainObject(raw)) {
    if (!isPlainObject(canonical)) throw new RestorePreflightError(name, `${at} has an invalid type`);
    for (const [key, rawValue] of Object.entries(raw)) {
      const child = `${at}.${key}`;
      if (!Object.prototype.hasOwnProperty.call(canonical, key)) {
        throw new RestorePreflightError(name, `${child} is unsupported or would be discarded`);
      }
      assertNoLossyNormalization(name, rawValue, canonical[key], child, additions);
    }
    for (const key of Object.keys(canonical)) {
      if (!Object.prototype.hasOwnProperty.call(raw, key)) additions.push(`${at}.${key}`);
    }
    return;
  }
  if (Array.isArray(raw)) {
    if (!Array.isArray(canonical) || raw.length !== canonical.length) {
      throw new RestorePreflightError(name, `${at} contains an invalid, duplicate, or discarded item`);
    }
    raw.forEach((value, index) => {
      assertNoLossyNormalization(name, value, canonical[index], `${at}[${String(index)}]`, additions);
    });
    return;
  }
  if (!Object.is(raw, canonical)) {
    if (isKnownLosslessScalarCoercion(name, at, raw, canonical)) {
      additions.push(at);
      return;
    }
    throw new RestorePreflightError(name, `${at} is invalid or would be changed`);
  }
}

function isKnownLosslessScalarCoercion(name: string, at: string, raw: unknown, canonical: unknown): boolean {
  if (typeof raw === 'string' && typeof canonical === 'string' && raw.trim() === canonical) {
    return true;
  }
  if (typeof raw === 'string' && typeof canonical === 'number') {
    const parsed = Number(raw.trim());
    return raw.trim().length > 0 && Number.isFinite(parsed) && Object.is(parsed, canonical);
  }
  if (
    name === 'runtime.json' &&
    (at === '$.hookAutoLoad' || at === '$.webuiTls.enabled') &&
    typeof canonical === 'boolean'
  ) {
    if (raw === 1 || raw === 0) return canonical === (raw === 1);
    if (typeof raw !== 'string') return false;
    const token = raw.trim().toLowerCase();
    const truthy = new Set(['true', '1', 'yes', 'on']);
    const falsy = new Set(['false', '0', 'no', 'off', '']);
    return (canonical && truthy.has(token)) || (!canonical && falsy.has(token));
  }
  return false;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(JSON.stringify(value, null, 2), 'utf8');
}

function isValidBindHost(value: string): boolean {
  const host = value.trim();
  if (!host || host !== value || host.length > 253 || /[\s/?#@]/u.test(host)) return false;
  if (host.includes(':')) return isIP(host) === 6;
  if (/^[\d.]+$/.test(host)) {
    return isIP(host) === 4;
  }
  const normalized = host.endsWith('.') ? host.slice(0, -1) : host;
  return normalized.split('.').every((label) => /^(?!-)[A-Za-z0-9-]{1,63}(?<!-)$/.test(label));
}

function validateEffectiveTls(restore: PreparedRestoreFile[], opts: PrepareRestoreOptions): void {
  const byName = new Map(restore.map((file) => [file.name, file.data]));
  const pairTouched = byName.has('cert.pem') || byName.has('key.pem');
  const tlsRelated = pairTouched || byName.has('runtime.json');
  if (!tlsRelated) return;

  const readEffective = (name: string): Buffer | null => {
    const prepared = byName.get(name);
    if (prepared) return prepared;
    try {
      return opts.readCurrent(name);
    } catch (error) {
      throw new RestorePreflightError(name, `failed to read current file: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const runtime = readEffective('runtime.json');
  let tlsEnabled = false;
  if (runtime) {
    try {
      tlsEnabled = normalizeRuntimeConfig(JSON.parse(runtime.toString('utf8')) as unknown).webuiTls?.enabled === true;
    } catch (error) {
      throw new RestorePreflightError('runtime.json', 'effective runtime config is invalid JSON', { cause: error });
    }
  }

  if (!tlsEnabled && !pairTouched) return;
  const cert = readEffective('cert.pem');
  const key = readEffective('key.pem');

  if (cert && key) {
    const valid = validateTlsPair(cert, key);
    if (!valid.ok) throw new RestorePreflightError('cert.pem + key.pem', valid.reason ?? 'TLS pair is invalid');
    return;
  }
  if (tlsEnabled) {
    throw new RestorePreflightError('cert.pem + key.pem', 'TLS is enabled but the effective certificate/private-key pair is incomplete');
  }
}

function validateEffectiveUi(restore: PreparedRestoreFile[], opts: PrepareRestoreOptions): void {
  const byName = new Map(restore.map((file) => [file.name, file.data]));
  if (!byName.has('ui.json') && !byName.has('ui-assets/background')) return;

  const readEffective = (name: string): Buffer | null => {
    const prepared = byName.get(name);
    if (prepared) return prepared;
    try {
      return opts.readCurrent(name);
    } catch (error) {
      throw new RestorePreflightError(name, `failed to read current file: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
    }
  };
  const uiBytes = readEffective('ui.json');
  if (!uiBytes) return;

  let ui;
  try {
    ui = normalizeStoredUiConfig(JSON.parse(uiBytes.toString('utf8')) as unknown);
  } catch (error) {
    throw new RestorePreflightError('ui.json', 'effective UI config is invalid JSON', { cause: error });
  }
  const background = ui.appearance.background;
  if (!background.hasImage) return;

  const image = readEffective('ui-assets/background');
  if (!image) {
    throw new RestorePreflightError('ui.json + ui-assets/background', 'background metadata says an image exists, but the effective image is missing');
  }
  if (image.length > MAX_BACKGROUND_BYTES) {
    throw new RestorePreflightError('ui.json + ui-assets/background', `effective background exceeds ${String(MAX_BACKGROUND_BYTES)} bytes`);
  }
  const mime = sniffImageMime(image);
  if (!mime) {
    throw new RestorePreflightError('ui.json + ui-assets/background', 'effective background is not PNG, JPEG, or WebP');
  }
  if (mime !== background.imageMime) {
    throw new RestorePreflightError(
      'ui.json + ui-assets/background',
      `background metadata MIME ${background.imageMime} does not match image bytes ${mime}`,
    );
  }
}
