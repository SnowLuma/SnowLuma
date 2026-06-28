import { createLogger } from '@snowluma/common/logger';
import fs from 'fs';
import path from 'path';
import type { JsonObject, RKeyConfig } from './types';

const log = createLogger('OneBot.GlobalConfig');

const CONFIG_DIR = 'config';
const GLOBAL_CONFIG_PATH = path.join(CONFIG_DIR, 'snowluma.json');

/**
 * Global, all-accounts SnowLuma protocol settings — the home for small
 * deployment-wide knobs that are NOT per-UIN (so they don't belong in
 * `onebot_<uin>.json`). Persisted as `config/snowluma.json`. New small global
 * settings should be added here rather than spawning a file/page per feature.
 */
export interface GlobalSettings {
  /** Opt-in remote rkey fallback (see RKeyConfig). Default: servers empty = off. */
  rkey: RKeyConfig;
  /** Music-card signing service URL. Deployment-wide (same service for every
   *  account), so global rather than per-UIN. Empty = use the built-in default. */
  musicSignUrl: string;
}

export function defaultGlobalSettings(): GlobalSettings {
  return { rkey: { fallbackServers: [] }, musicSignUrl: '' };
}

/** Keep only well-formed, deduped http(s) URLs (must parse + have a host). */
export function normalizeRkeyServers(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const seen = new Set<string>();
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') continue;
    const v = item.trim();
    if (!v || !isHttpUrl(v) || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

function isHttpUrl(value: string): boolean {
  try {
    const u = new URL(value);
    return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0;
  } catch {
    return false;
  }
}

// NOTE: when adding a new section, extend normalizeGlobalSettings, toJson AND
// saveGlobalSettings in lockstep. normalize/toJson only copy known sections, so
// an un-handled on-disk section is silently dropped on the next load+save — the
// section-merge in saveGlobalSettings only guards against a request OMITTING a
// section, not against this load/serialize pipeline discarding an unknown one.
export function normalizeGlobalSettings(value: unknown): GlobalSettings {
  const out = defaultGlobalSettings();
  if (!isObject(value)) return out;
  const rkey = value.rkey;
  if (isObject(rkey)) {
    out.rkey.fallbackServers = normalizeRkeyServers(rkey.fallbackServers);
  }
  if (typeof value.musicSignUrl === 'string') {
    const v = value.musicSignUrl.trim();
    // Empty = "use built-in default"; otherwise must be a real http(s) endpoint.
    out.musicSignUrl = v && isHttpUrl(v) ? v : '';
  }
  return out;
}

export function loadGlobalSettings(): GlobalSettings {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return defaultGlobalSettings();
  try {
    const raw = fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8');
    return normalizeGlobalSettings(JSON.parse(raw) as unknown);
  } catch (err) {
    log.warn('config/snowluma.json is corrupt and will be ignored: %s', err instanceof Error ? err.message : String(err));
    return defaultGlobalSettings();
  }
}

/**
 * Persist global settings, SECTION-MERGING over what's on disk: only the
 * top-level sections actually present in `incoming` are overwritten, so a
 * partial save (e.g. just `rkey`) never wipes a sibling knob. Mirrors
 * saveNotificationsConfig's merge discipline.
 */
export function saveGlobalSettings(incoming: unknown): GlobalSettings {
  const merged = loadGlobalSettings();
  if (isObject(incoming)) {
    if (isObject(incoming.rkey)) {
      merged.rkey.fallbackServers = normalizeRkeyServers(incoming.rkey.fallbackServers);
    }
    if (typeof incoming.musicSignUrl === 'string') {
      const v = incoming.musicSignUrl.trim();
      merged.musicSignUrl = v && isHttpUrl(v) ? v : '';
    }
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = GLOBAL_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(toJson(merged), null, 2), 'utf8');
  fs.renameSync(tmp, GLOBAL_CONFIG_PATH);
  return merged;
}

function toJson(settings: GlobalSettings): JsonObject {
  return {
    rkey: { fallbackServers: settings.rkey.fallbackServers },
    musicSignUrl: settings.musicSignUrl,
  };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * One-shot copy-up: `musicSignUrl` used to live in per-UIN config. If the global
 * store has none yet, lift the first non-empty value found in any legacy
 * `config/onebot*.json` into `config/snowluma.json`. Idempotent — skips once the
 * global value is set. (If an operator later clears the global value while a
 * stale per-UIN value lingers, a restart would re-copy it; benign and rare.)
 */
export function migrateGlobalSettings(): void {
  // One-shot guard keyed on PRESENCE (not truthiness): once snowluma.json carries
  // a musicSignUrl key — written by this migration or any global-config save —
  // never re-scan. This is what stops an operator's intentional clear-to-'' from
  // being reverted by a stale legacy value on the next boot.
  if (globalConfigHasMusicSignUrlKey()) return;

  const found = scanLegacyMusicSignUrl();
  if (!found) return;

  saveGlobalSettings({ musicSignUrl: found.value });
  const extra = found.others.length ? `; ignored differing value(s) in ${found.others.join(', ')}` : '';
  log.info('migrated musicSignUrl to global config from %s: %s%s', found.source, found.value, extra);
}

function globalConfigHasMusicSignUrlKey(): boolean {
  if (!fs.existsSync(GLOBAL_CONFIG_PATH)) return false;
  try {
    const raw = JSON.parse(fs.readFileSync(GLOBAL_CONFIG_PATH, 'utf8')) as unknown;
    return isObject(raw) && 'musicSignUrl' in raw;
  } catch {
    return false;
  }
}

interface LegacyMusicSignUrl {
  value: string;
  source: string;
  others: string[];
}

/** Scan config/onebot.json + config/onebot_<uin>.json for a non-empty
 *  musicSignUrl. Returns the first found plus any other files that carried a
 *  (differing) value, for logging. */
function scanLegacyMusicSignUrl(): LegacyMusicSignUrl | null {
  let dir: string[];
  try {
    dir = fs.readdirSync(CONFIG_DIR);
  } catch {
    return null;
  }
  const files = dir
    .filter((f) => f === 'onebot.json' || /^onebot_\d+\.json$/.test(f))
    .sort();

  let first: { value: string; source: string } | null = null;
  const others: string[] = [];
  for (const file of files) {
    let value: unknown;
    try {
      const raw = JSON.parse(fs.readFileSync(path.join(CONFIG_DIR, file), 'utf8')) as unknown;
      value = isObject(raw) ? raw.musicSignUrl : undefined;
    } catch {
      continue;
    }
    if (typeof value !== 'string') continue;
    const v = value.trim();
    // Skip empty AND invalid here, so "first found" means "first usable" — a
    // garbage value in an earlier-sorting file can't shadow a real URL in a
    // later one (it would be dropped to '' on save and then locked by the guard).
    if (!v || !isHttpUrl(v)) continue;
    if (!first) first = { value: v, source: file };
    else if (v !== first.value) others.push(file);
  }
  return first ? { ...first, others } : null;
}
