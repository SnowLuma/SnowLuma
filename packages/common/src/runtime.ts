import fs from 'fs';
import path from 'path';

export interface RuntimeConfig {
  webuiPort?: number;
  /** When true, every newly-discovered QQ process gets auto-injected by
   * the HookManager. Also overridable at runtime via SNOWLUMA_HOOK_AUTOLOAD.
   * Defaults to false; the Docker image flips it on in supervisord.conf. */
  hookAutoLoad?: boolean;
  /** WebUI listener bind address. '127.0.0.1' = localhost-only (default),
   * '0.0.0.0' = all IPv4 interfaces. Listener-level: change needs a restart. */
  webuiHost?: string;
  /** WebUI TLS. Cert/key live in config/cert.pem + config/key.pem; this
   * only flips serving on/off. Listener-level: change needs a restart. */
  webuiTls?: { enabled?: boolean };
  /** Raw trust-proxy directive (same domain as SNOWLUMA_WEBUI_TRUST_PROXY),
   * consumed by the WebUI's client-ip resolver. '' = trust nobody. */
  trustProxy?: string;
  /** Aggregate cap for every managed file below the log root. */
  logMaxTotalMb?: number;
  /** Calendar-day retention. Zero disables date-based deletion. */
  logRetainDays?: number;
  /** Duplicate UIN-scoped lines into logs/<uin>/ in addition to the shared log. */
  logPerUin?: boolean;
}

const CONFIG_DIR = 'config';
const RUNTIME_CONFIG_PATH = path.join(CONFIG_DIR, 'runtime.json');

const DEFAULT_WEBUI_PORT = 5099;
const DEFAULT_WEBUI_HOST = '127.0.0.1';
export const DEFAULT_LOG_MAX_TOTAL_MB = 1024;
export const DEFAULT_LOG_RETAIN_DAYS = 7;
export const DEFAULT_LOG_PER_UIN = false;
export const MAX_LOG_TOTAL_MB = Math.floor(Number.MAX_SAFE_INTEGER / (1024 * 1024));
export const MAX_LOG_RETAIN_DAYS = Math.floor(
  Number.MAX_SAFE_INTEGER / (24 * 60 * 60 * 1000),
);

/**
 * Pure on-disk-object → typed config normalization (defaults + validation,
 * no fs / no env). Exported for testing; `loadRuntimeConfig` wraps it.
 */
export function normalizeRuntimeConfig(parsed: unknown): RuntimeConfig {
  const obj = isObject(parsed) ? parsed : {};
  return {
    webuiPort: normalizePort(obj.webuiPort ?? DEFAULT_WEBUI_PORT, DEFAULT_WEBUI_PORT),
    hookAutoLoad: normalizeBool(obj.hookAutoLoad, false),
    webuiHost: normalizeHost(obj.webuiHost),
    webuiTls: { enabled: isObject(obj.webuiTls) ? normalizeBool(obj.webuiTls.enabled, false) : false },
    trustProxy: typeof obj.trustProxy === 'string' ? obj.trustProxy : '',
    logMaxTotalMb: normalizeRequiredInteger(
      obj.logMaxTotalMb,
      DEFAULT_LOG_MAX_TOTAL_MB,
      1,
      MAX_LOG_TOTAL_MB,
      'logMaxTotalMb',
    ),
    logRetainDays: normalizeRequiredInteger(
      obj.logRetainDays,
      DEFAULT_LOG_RETAIN_DAYS,
      0,
      MAX_LOG_RETAIN_DAYS,
      'logRetainDays',
    ),
    logPerUin: normalizeRequiredBool(obj.logPerUin, DEFAULT_LOG_PER_UIN, 'logPerUin'),
  };
}

/**
 * Pure SNOWLUMA_* env → override patch (no fs). Env wins over runtime.json
 * (a trusted launcher like SnowLumaDesktop pins these per-launch without
 * rewriting the file). Absent vars produce no key.
 */
export function resolveRuntimeEnvOverrides(env: NodeJS.ProcessEnv): Partial<RuntimeConfig> {
  const out: Partial<RuntimeConfig> = {};

  const port = parsePortString(env.SNOWLUMA_WEBUI_PORT);
  if (port !== undefined) out.webuiPort = port;

  const host = env.SNOWLUMA_WEBUI_HOST;
  if (typeof host === 'string' && host.trim()) out.webuiHost = host.trim();

  // Present-but-"0"/"off" is a deliberate override (trust nobody), distinct
  // from "absent" — so gate on key presence, not truthiness.
  const tp = env.SNOWLUMA_WEBUI_TRUST_PROXY;
  if (typeof tp === 'string') out.trustProxy = tp;

  const logMaxTotalMb = parseRequiredIntegerEnv(
    env.SNOWLUMA_LOG_MAX_TOTAL_MB,
    1,
    MAX_LOG_TOTAL_MB,
    'SNOWLUMA_LOG_MAX_TOTAL_MB',
  );
  if (logMaxTotalMb !== undefined) out.logMaxTotalMb = logMaxTotalMb;

  const logRetainDays = parseRequiredIntegerEnv(
    env.SNOWLUMA_LOG_RETAIN_DAYS,
    0,
    MAX_LOG_RETAIN_DAYS,
    'SNOWLUMA_LOG_RETAIN_DAYS',
  );
  if (logRetainDays !== undefined) out.logRetainDays = logRetainDays;

  const logPerUin = parseRequiredBoolEnv(
    env.SNOWLUMA_LOG_PER_UIN,
    'SNOWLUMA_LOG_PER_UIN',
  );
  if (logPerUin !== undefined) out.logPerUin = logPerUin;

  return out;
}

export function loadRuntimeConfig(): RuntimeConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });

  const parsed = tryLoadRuntimeConfig();
  const normalized = normalizeRuntimeConfig(parsed ?? {});

  // Persist when the file is absent or when normalization changed/backfilled
  // anything (e.g. an older runtime.json lacking webuiHost/webuiTls).
  if (parsed === null || !sameRuntimeConfig(parsed, normalized)) {
    saveRuntimeConfig(normalized);
  }

  // Env overrides apply in-memory only — never written back to disk.
  return { ...normalized, ...resolveRuntimeEnvOverrides(process.env) };
}

/**
 * Read the persisted config (normalized, no env overrides, no write). For the
 * settings panel's GET — shows what's actually saved/editable on disk.
 */
export function readRuntimeConfig(): RuntimeConfig {
  return normalizeRuntimeConfig(tryLoadRuntimeConfig() ?? {});
}

/**
 * Persist a partial update. Merges onto the ON-DISK config (not the env-merged
 * runtime view) so an env override (e.g. SNOWLUMA_WEBUI_PORT) is never baked
 * into runtime.json. Returns the new persisted config (without env overrides).
 */
export function updateRuntimeConfig(patch: Partial<RuntimeConfig>): RuntimeConfig {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const onDisk = normalizeRuntimeConfig(tryLoadRuntimeConfig() ?? {});
  const next = normalizeRuntimeConfig({ ...onDisk, ...patch });
  saveRuntimeConfig(next);
  return next;
}

function tryLoadRuntimeConfig(): Record<string, unknown> | null {
  if (!fs.existsSync(RUNTIME_CONFIG_PATH)) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(RUNTIME_CONFIG_PATH, 'utf8')) as unknown;
    return isObject(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function saveRuntimeConfig(config: RuntimeConfig): void {
  const temporaryPath = `${RUNTIME_CONFIG_PATH}.tmp-${String(process.pid)}`;
  try {
    fs.writeFileSync(temporaryPath, JSON.stringify(config, null, 2), 'utf8');
    fs.renameSync(temporaryPath, RUNTIME_CONFIG_PATH);
  } catch (error) {
    try {
      fs.unlinkSync(temporaryPath);
    } catch (cleanupError) {
      if (!isErrnoCode(cleanupError, 'ENOENT')) {
        throw new AggregateError(
          [error, cleanupError],
          'failed to persist runtime config and remove its temporary file',
        );
      }
    }
    throw error;
  }
}

/** True when the raw on-disk object already matches the normalized config
 *  on every known field (so we can skip a needless rewrite). */
function sameRuntimeConfig(parsed: Record<string, unknown>, n: RuntimeConfig): boolean {
  const parsedTls = isObject(parsed.webuiTls) ? parsed.webuiTls.enabled : undefined;
  return (
    parsed.webuiPort === n.webuiPort
    && parsed.hookAutoLoad === n.hookAutoLoad
    && parsed.webuiHost === n.webuiHost
    && parsedTls === n.webuiTls?.enabled
    && parsed.trustProxy === n.trustProxy
    && parsed.logMaxTotalMb === n.logMaxTotalMb
    && parsed.logRetainDays === n.logRetainDays
    && parsed.logPerUin === n.logPerUin
  );
}

function parsePortString(raw: unknown): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const n = Number(raw.trim());
  if (!Number.isFinite(n)) return undefined;
  const port = Math.trunc(n);
  if (port <= 0 || port > 65535) return undefined;
  return port;
}

function normalizeHost(value: unknown): string {
  if (typeof value === 'string' && value.trim()) return value.trim();
  return DEFAULT_WEBUI_HOST;
}

function normalizePort(value: unknown, fallback: number): number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value);
    if (n > 0 && n <= 65535) return n;
    return fallback;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    if (Number.isFinite(n)) {
      const port = Math.trunc(n);
      if (port > 0 && port <= 65535) return port;
    }
  }
  return fallback;
}

function normalizeRequiredInteger(
  value: unknown,
  fallback: number,
  min: number,
  max: number,
  field: string,
): number {
  if (value === undefined) return fallback;
  const n = typeof value === 'string' && value.trim() ? Number(value.trim()) : value;
  if (
    typeof n === 'number'
    && Number.isSafeInteger(n)
    && n >= min
    && n <= max
  ) {
    return n;
  }
  throw new RangeError(`${field} must be an integer in ${String(min)}..${String(max)}`);
}

function normalizeRequiredBool(
  value: unknown,
  fallback: boolean,
  field: string,
): boolean {
  if (value === undefined) return fallback;
  const parsed = parseBoolValue(value);
  if (parsed !== undefined) return parsed;
  throw new TypeError(`${field} must be a boolean`);
}

function normalizeBool(value: unknown, fallback: boolean): boolean {
  if (typeof value === 'boolean') return value;
  if (typeof value === 'number') return value !== 0;
  if (typeof value === 'string') {
    const v = value.trim().toLowerCase();
    if (v === 'true' || v === '1' || v === 'yes' || v === 'on') return true;
    if (v === 'false' || v === '0' || v === 'no' || v === 'off' || v === '') return false;
  }
  return fallback;
}

function parseRequiredIntegerEnv(
  raw: unknown,
  min: number,
  max: number,
  field: string,
): number | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const n = Number(raw.trim());
  if (Number.isSafeInteger(n) && n >= min && n <= max) return n;
  throw new RangeError(`${field} must be an integer in ${String(min)}..${String(max)}`);
}

function parseRequiredBoolEnv(raw: unknown, field: string): boolean | undefined {
  if (typeof raw !== 'string' || !raw.trim()) return undefined;
  const parsed = parseBoolValue(raw);
  if (parsed !== undefined) return parsed;
  throw new TypeError(`${field} must be a boolean`);
}

function parseBoolValue(raw: unknown): boolean | undefined {
  if (typeof raw === 'boolean') return raw;
  if (raw === 1) return true;
  if (raw === 0) return false;
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().toLowerCase();
  if (value === 'true' || value === '1' || value === 'yes' || value === 'on') return true;
  if (value === 'false' || value === '0' || value === 'no' || value === 'off') return false;
  return undefined;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isErrnoCode(error: unknown, code: string): boolean {
  return error instanceof Error && 'code' in error && error.code === code;
}
