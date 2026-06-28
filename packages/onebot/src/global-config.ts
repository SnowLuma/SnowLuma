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
}

export function defaultGlobalSettings(): GlobalSettings {
  return { rkey: { fallbackServers: [] } };
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
  }
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
  const tmp = GLOBAL_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(toJson(merged), null, 2), 'utf8');
  fs.renameSync(tmp, GLOBAL_CONFIG_PATH);
  return merged;
}

function toJson(settings: GlobalSettings): JsonObject {
  return { rkey: { fallbackServers: settings.rkey.fallbackServers } };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
