// Global notification-channel store + the pure template renderer.
//
// Mirrors the conventions of `webui/ui-config.ts` (the plan calls for this
// explicitly): every `normalize*` is TOTAL — any unknown / corrupt input
// collapses to a safe default, numbers clamp, unknown keys are dropped — and
// persistence is an atomic write (tmp → rename) behind a module-level cache.
//
// Channels are GLOBAL (defined once here); each UIN opts into a subset via
// `OneBotConfig.notifications.channelIds` (see packages/onebot/src/config.ts).
import { createLogger } from '@snowluma/common/logger';
import fs from 'fs';
import path from 'path';

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

/** event ∈ {offline, online}; rendered verbatim into `{event}`. */
export type NotificationEvent = 'offline' | 'online';

export interface NotificationChannel {
  id: string;
  name: string;
  url: string;
  bodyTemplate: string;
  enabled: boolean;
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

// ─── Normalization helpers (replicated from ui-config conventions) ──────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

function clampInt(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.trunc(Math.min(max, Math.max(min, n)));
}

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

/** A channel is usable only with a valid id AND an http(s) target — anything
 *  else is unusable, so the whole entry is dropped (total normalize). */
function normalizeChannel(raw: unknown): NotificationChannel | null {
  if (!isObject(raw)) return null;
  const id = normalizeChannelId(raw.id);
  if (!id) return null;
  const url = typeof raw.url === 'string' ? raw.url.trim() : '';
  if (!isHttpUrl(url)) return null;
  const name = strOr(raw.name, id, CHANNEL_NAME_MAX).trim() || id;
  return {
    id,
    name,
    url,
    bodyTemplate: strOr(raw.bodyTemplate, DEFAULT_BODY_TEMPLATE, BODY_TEMPLATE_MAX),
    enabled: boolOr(raw.enabled, true),
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

function atomicWrite(config: NotificationsConfig): void {
  ensureConfigDir();
  const tmp = NOTIFICATIONS_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, NOTIFICATIONS_CONFIG_PATH);
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

  try {
    const raw = fs.readFileSync(NOTIFICATIONS_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    const normalized = normalizeNotificationsConfig(parsed);
    // Self-heal on disk only if normalization changed something (corrupt/old).
    if (JSON.stringify(parsed) !== JSON.stringify(normalized)) {
      try {
        atomicWrite(normalized);
      } catch {
        /* best-effort self-heal */
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
