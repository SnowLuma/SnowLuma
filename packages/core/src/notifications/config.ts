// Global notification-channel store + the pure template renderer.
//
// Mirrors the conventions of `webui/ui-config.ts` (the plan calls for this
// explicitly): every `normalize*` is TOTAL — any unknown / corrupt input
// collapses to a safe default, numbers clamp, unknown keys are dropped — and
// persistence is an atomic write (tmp → rename) behind a module-level cache.
//
// Channels are GLOBAL (defined once here); each UIN opts into a subset via
// `OneBotConfig.notifications.channelIds` (see packages/onebot/src/config.ts).
import { boolOr, clampInt, isObject } from '@snowluma/common/coerce';
import { createLogger } from '@snowluma/common/logger';
import fs from 'fs';
import path from 'path';
import { extractAddress, parseRecipients } from './smtp';

const log = createLogger('Notifications.Config');

const CONFIG_DIR = 'config';
const NOTIFICATIONS_CONFIG_PATH = path.join(CONFIG_DIR, 'notifications.json');

export const NOTIFICATIONS_CONFIG_VERSION = 1 as const;

export const DEBOUNCE_SECONDS_MIN = 0;
export const DEBOUNCE_SECONDS_MAX = 3600;
export const DEFAULT_DEBOUNCE_SECONDS = 30;

/** A channel id is a slug: it is referenced by per-UIN `channelIds`, so it must
 *  be safe to use as a stable key. Kept in sync with `normalizeChannelIds` in
 *  packages/onebot/src/config.ts (cross-package; can't share without a circular
 *  dep — core depends on onebot, not the reverse). */
export const CHANNEL_ID_RE = /^[\w.-]+$/;
const CHANNEL_ID_MAX = 64;
const CHANNEL_NAME_MAX = 128;
const BODY_TEMPLATE_MAX = 8192;
const HEADER_NAME_MAX = 128;
const HEADER_VALUE_MAX = 1024;
const HEADERS_MAX = 16;
const HEADER_NAME_RE = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;

/** event ∈ {offline, online}; rendered verbatim into `{event}`. */
export type NotificationEvent = 'offline' | 'online';

export type NotificationChannelType = 'webhook' | 'email';

export interface NotificationChannel {
  id: string;
  name: string;
  type: NotificationChannelType;
  /** http(s) webhook target. Empty on email channels. */
  url: string;
  bodyTemplate: string;
  enabled: boolean;
  /** Extra outbound request headers (Authorization, etc.). Webhook only. */
  headers?: Record<string, string>;
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  from?: string;
  to?: string;
  subjectTemplate?: string;
}

export function isEmailChannel(ch: NotificationChannel): ch is NotificationChannel & {
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  from: string;
  to: string;
  subjectTemplate: string;
} {
  return ch.type === 'email';
}

export interface NotificationsConfig {
  version: typeof NOTIFICATIONS_CONFIG_VERSION;
  debounceSeconds: number;
  channels: NotificationChannel[];
}

/** Default body template — Server酱-style JSON ({title}/{desp}). The WebUI
 *  ships additional per-vendor presets (钉钉/Discord/…) as frontend constants
 *  the operator can drop in. */
export const DEFAULT_BODY_TEMPLATE = `{
  "title": "账号状态通知：{event}",
  "desp": "您的账号状态发生了改变。\\n\\n**昵称**：{nickname}\\n**QQ号**：{uin}\\n**当前状态**：{event}\\n**时间**：{time}"
}`;

export const DEFAULT_SUBJECT_TEMPLATE = '账号{event}：{nickname} ({uin})';

export const DEFAULT_EMAIL_BODY_TEMPLATE = `账号状态发生了改变。

昵称：{nickname}
QQ号：{uin}
当前状态：{event}
时间：{time}`;

const SMTP_HOST_MAX = 253;
const SMTP_USER_MAX = 256;
const SMTP_PASS_MAX = 256;
const EMAIL_FIELD_MAX = 1024;
const SUBJECT_TEMPLATE_MAX = 256;
const SMTP_PORT_MIN = 1;
const SMTP_PORT_MAX = 65535;

export function defaultNotificationsConfig(): NotificationsConfig {
  return {
    version: NOTIFICATIONS_CONFIG_VERSION,
    debounceSeconds: DEFAULT_DEBOUNCE_SECONDS,
    channels: [],
  };
}

// ─── Template renderer ──────────────────────────────────────────────────────

/**
 * Mechanical `{key}` substitution — no logic, no conditionals, no escaping.
 * A key present in `vars` is replaced by its value; an unknown `{key}` is left
 * untouched (原样) so a typo'd placeholder is visible rather than silently
 * blanked. Pure + total (a non-string template yields '').
 *
 * **JSON safety**: When the template is valid JSON (parseable by JSON.parse),
 * values are escaped to prevent breaking the JSON structure — backslashes
 * become `\\` and double-quotes become `\"`.
 */
export function renderTemplate(template: string, vars: Record<string, string>): string {
  if (typeof template !== 'string') return '';
  let isJson = false;
  try {
    JSON.parse(template);
    isJson = true;
  } catch {
    // not JSON — plain text mode
  }
  return template.replace(/\{(\w+)\}/g, (match, key: string) => {
    if (!Object.prototype.hasOwnProperty.call(vars, key)) return match;
    const val = vars[key];
    return isJson ? val.replace(/\\/g, '\\\\').replace(/"/g, '\\"') : val;
  });
}

// ─── Normalization helpers ──────────────────────────────────────────────────
// isObject / boolOr / clampInt come from @snowluma/common/coerce. strOr is
// notifications-only (string truncation to maxLen), so it stays here.

function strOr(value: unknown, fallback: string, maxLen: number): string {
  return typeof value === 'string' ? value.slice(0, maxLen) : fallback;
}

function normalizeChannelId(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length === 0 || v.length > CHANNEL_ID_MAX) return null;
  if (!CHANNEL_ID_RE.test(v)) return null;
  return v;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return u.protocol === 'http:' || u.protocol === 'https:';
  } catch {
    return false;
  }
}

function normalizeHeaders(value: unknown): Record<string, string> | undefined {
  if (!isObject(value)) return undefined;
  const out: Record<string, string> = {};
  const seen = new Set<string>();
  for (const [rawName, rawValue] of Object.entries(value)) {
    if (Object.keys(out).length >= HEADERS_MAX) break;
    if (typeof rawValue !== 'string') continue;
    const name = rawName.trim();
    if (name.length === 0 || name.length > HEADER_NAME_MAX) continue;
    if (!HEADER_NAME_RE.test(name)) continue;
    const folded = name.toLowerCase();
    if (seen.has(folded)) continue;
    const headerValue = rawValue.trim();
    if (headerValue.length === 0 || headerValue.length > HEADER_VALUE_MAX) continue;
    if (headerValue.includes('\r') || headerValue.includes('\n')) continue;
    seen.add(folded);
    out[name] = headerValue;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

function normalizeSmtpHost(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (!v || v.length > SMTP_HOST_MAX) return null;
  if (/\s/.test(v) || v.includes('/') || v.includes('://')) return null;
  return v;
}

function normalizeFrom(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim().slice(0, EMAIL_FIELD_MAX);
  return extractAddress(v) ? v : null;
}

function normalizeTo(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const addrs = parseRecipients(value.trim().slice(0, EMAIL_FIELD_MAX));
  return addrs.length > 0 ? addrs.join(', ') : null;
}

function normalizeChannelType(value: unknown): NotificationChannelType | null {
  if (value === 'email') return 'email';
  if (value === 'webhook' || value === undefined || value === '') return 'webhook';
  return null;
}

function normalizeEmailChannel(
  raw: Record<string, unknown>,
  id: string,
  name: string,
): NotificationChannel | null {
  const smtpHost = normalizeSmtpHost(raw.smtpHost);
  const from = normalizeFrom(raw.from);
  const to = normalizeTo(raw.to);
  if (!smtpHost || !from || !to) return null;

  const portRaw = raw.smtpPort;
  const portProvided = portRaw !== undefined && portRaw !== null && portRaw !== '';
  const secureProvided = typeof raw.smtpSecure === 'boolean';
  const port = portProvided
    ? clampInt(portRaw, SMTP_PORT_MIN, SMTP_PORT_MAX, 0)
    : 0;
  if (portProvided && port === 0) return null;

  const smtpSecure = secureProvided ? Boolean(raw.smtpSecure) : port === 465 || port === 0;
  const smtpPort = port === 0 ? (smtpSecure ? 465 : 587) : port;

  const smtpUser = typeof raw.smtpUser === 'string' ? raw.smtpUser.trim().slice(0, SMTP_USER_MAX) : '';
  const smtpPass = typeof raw.smtpPass === 'string' ? raw.smtpPass.slice(0, SMTP_PASS_MAX) : '';

  return {
    id,
    name,
    type: 'email',
    url: '',
    bodyTemplate: strOr(raw.bodyTemplate, DEFAULT_EMAIL_BODY_TEMPLATE, BODY_TEMPLATE_MAX),
    enabled: boolOr(raw.enabled, true),
    smtpHost,
    smtpPort,
    smtpSecure,
    ...(smtpUser ? { smtpUser } : {}),
    ...(smtpPass ? { smtpPass } : {}),
    from,
    to,
    subjectTemplate: strOr(raw.subjectTemplate, DEFAULT_SUBJECT_TEMPLATE, SUBJECT_TEMPLATE_MAX) || DEFAULT_SUBJECT_TEMPLATE,
  };
}

/** A channel is usable only with a valid id AND a deliverable target —
 *  http(s) URL for webhooks, SMTP host + from/to for email. Anything else
 *  is dropped (total normalize). */
function normalizeChannel(raw: unknown): NotificationChannel | null {
  if (!isObject(raw)) return null;
  const id = normalizeChannelId(raw.id);
  if (!id) return null;
  const type = normalizeChannelType(raw.type);
  if (!type) return null;
  const name = strOr(raw.name, id, CHANNEL_NAME_MAX).trim() || id;
  if (type === 'email') return normalizeEmailChannel(raw, id, name);

  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!isHttpUrl(url)) return null;
  const headers = normalizeHeaders(raw.headers);
  return {
    id,
    name,
    type: 'webhook',
    url,
    bodyTemplate: strOr(raw.bodyTemplate, DEFAULT_BODY_TEMPLATE, BODY_TEMPLATE_MAX),
    enabled: boolOr(raw.enabled, true),
    ...(headers ? { headers } : {}),
  };
}

function normalizeChannels(value: unknown): NotificationChannel[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: NotificationChannel[] = [];
  for (const raw of value) {
    const ch = normalizeChannel(raw);
    if (!ch) continue;
    if (seen.has(ch.id)) continue; // dedupe by id — first occurrence wins
    seen.add(ch.id);
    out.push(ch);
  }
  return out;
}

export function normalizeNotificationsConfig(value: unknown): NotificationsConfig {
  const v = isObject(value) ? value : {};
  return {
    version: NOTIFICATIONS_CONFIG_VERSION,
    debounceSeconds: clampInt(
      v.debounceSeconds,
      DEBOUNCE_SECONDS_MIN,
      DEBOUNCE_SECONDS_MAX,
      DEFAULT_DEBOUNCE_SECONDS,
    ),
    channels: normalizeChannels(v.channels),
  };
}

// ─── Persistence (atomic write + module-level cache) ────────────────────────

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function enforceSensitiveFileMode(file: string): void {
  // POSIX mode bits do not model Windows ACLs; on Windows the inherited ACL
  // remains authoritative. Avoid pretending chmod provides equivalent policy.
  if (process.platform !== 'win32') fs.chmodSync(file, 0o600);
}

function atomicWrite(config: NotificationsConfig): void {
  ensureConfigDir();
  const tmp = NOTIFICATIONS_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), {
    encoding: 'utf8',
    mode: 0o600,
  });
  enforceSensitiveFileMode(tmp);
  fs.renameSync(tmp, NOTIFICATIONS_CONFIG_PATH);
  enforceSensitiveFileMode(NOTIFICATIONS_CONFIG_PATH);
}

let cached: NotificationsConfig | null = null;

/** Load + normalize the channel store, creating it from defaults if absent. */
export function loadNotificationsConfig(): NotificationsConfig {
  if (cached) return cached;
  ensureConfigDir();

  if (!fs.existsSync(NOTIFICATIONS_CONFIG_PATH)) {
    const fresh = defaultNotificationsConfig();
    try {
      atomicWrite(fresh);
    } catch (err) {
      log.warn('failed to write initial notifications.json: %s', err instanceof Error ? err.message : String(err));
    }
    cached = fresh;
    return fresh;
  }

  // Webhook URLs commonly embed credentials. Repair older permissive files
  // before reading them into memory so upgrades close the exposure promptly.
  enforceSensitiveFileMode(NOTIFICATIONS_CONFIG_PATH);

  try {
    const raw = fs.readFileSync(NOTIFICATIONS_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeNotificationsConfig(parsed);
    // Self-heal on disk only if normalization changed something (corrupt/old).
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      try {
        atomicWrite(normalized);
      } catch (err) {
        log.warn('failed to normalize notifications.json on disk: %s', err instanceof Error ? err.message : String(err));
      }
    }
    cached = normalized;
    return normalized;
  } catch (err) {
    log.warn('notifications.json unreadable; using defaults: %s', err instanceof Error ? err.message : String(err));
    const fresh = defaultNotificationsConfig();
    cached = fresh;
    return fresh;
  }
}

/**
 * Persist a (possibly partial) client-supplied config. A missing `channels` or
 * `debounceSeconds` keeps the current on-disk value — section-level merge, same
 * as `saveUiConfig`. Returns the stored, normalized config.
 */
export function saveNotificationsConfig(incoming: unknown): NotificationsConfig {
  const current = loadNotificationsConfig();
  const v = isObject(incoming) ? incoming : {};
  const next: NotificationsConfig = {
    version: NOTIFICATIONS_CONFIG_VERSION,
    debounceSeconds:
      v.debounceSeconds !== undefined
        ? clampInt(v.debounceSeconds, DEBOUNCE_SECONDS_MIN, DEBOUNCE_SECONDS_MAX, DEFAULT_DEBOUNCE_SECONDS)
        : current.debounceSeconds,
    channels: Array.isArray(v.channels) ? normalizeChannels(v.channels) : current.channels,
  };
  atomicWrite(next);
  cached = next;
  return next;
}
