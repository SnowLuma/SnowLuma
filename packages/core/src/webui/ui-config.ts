import { createLogger } from '@snowluma/common/logger';
import fs from 'fs';
import path from 'path';

// Server-side store for the WebUI customization config (`config/ui.json`).
//
// This is the single source of truth for appearance (A) + layout (C). The
// browser caches it in localStorage only to avoid a first-paint flash; the
// canonical copy lives here so a deployer's look + curated layout follow them
// across devices/browsers.
//
// Trust boundaries that this module enforces:
//   * `normalizeAppearance` is total — any unknown/corrupt input collapses to
//     safe defaults. This matters because the cosmetic subset is served to an
//     UNAUTHENTICATED client (the login page) via `GET /api/ui/public`, so it
//     must never echo attacker-controlled garbage.
//   * The background-IMAGE lifecycle fields (`hasImage` / `imageMime` /
//     `imageVersion`) are server-managed: a plain `POST /api/ui` cannot set
//     them. Only the dedicated upload/delete endpoints mutate them. A client
//     save preserves whatever is currently on disk.

const log = createLogger('WebUI.UiConfig');

const CONFIG_DIR = 'config';
const UI_CONFIG_PATH = path.join(CONFIG_DIR, 'ui.json');

/** Directory for operator-uploaded UI assets (currently just the background). */
export const UI_ASSETS_DIR = path.join(CONFIG_DIR, 'ui-assets');
/** Fixed path of the single background image (overwrite-on-upload). */
export const BACKGROUND_IMAGE_PATH = path.join(UI_ASSETS_DIR, 'background');
/** Reject uploads larger than this (bytes). */
export const MAX_BACKGROUND_BYTES = 5 * 1024 * 1024;

export const UI_CONFIG_VERSION = 1 as const;

// ─── Schema ──────────────────────────────────────────────────────────────

export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentMode = 'preset' | 'custom';
export type AccentScope = 'sidebar' | 'global';
export type DarkIntensity = 'soft' | 'black';
export type SidebarStyle = 'follow' | 'panel' | 'accent';
export type BackgroundType = 'none' | 'solid' | 'gradient' | 'image';
export type Density = 'cozy' | 'compact';
export type TimeFormat = '12h' | '24h';

export interface UiBackground {
  type: BackgroundType;
  /** Solid-fill colour (hex). Used when type === 'solid'. */
  color: string;
  /** Gradient preset id (frontend owns the catalogue). Used when type === 'gradient'. */
  gradient: string;
  /** Image readability overlay: 0 (image fully visible) … 1 (fully masked). */
  imageOpacity: number;
  /** Image blur in px (0…40). */
  imageBlur: number;
  // ── server-managed (upload/delete endpoints only) ──
  hasImage: boolean;
  imageMime: string;
  /** Bumped on each successful upload so the browser can cache-bust. */
  imageVersion: number;
}

export interface UiAppearance {
  mode: ThemeMode;
  accentMode: AccentMode;
  /** Preset accent id (frontend catalogue: sky/blue/violet/…). */
  accentPreset: string;
  /** Custom accent colour (hex). Used when accentMode === 'custom'. */
  accentCustom: string;
  accentScope: AccentScope;
  darkIntensity: DarkIntensity;
  sidebarStyle: SidebarStyle;
  background: UiBackground;
  /** Sans font preset id (frontend catalogue). */
  fontSans: string;
  /** Mono font preset id (frontend catalogue). */
  fontMono: string;
  /** Global UI scale, 0.9…1.2. */
  uiScale: number;
  /** Corner radius in rem, 0…2. */
  radius: number;
  density: Density;
  reduceMotion: boolean;
  highContrast: boolean;
  sidebarDefaultCollapsed: boolean;
  timeFormat: TimeFormat;
  /** Dashboard poll interval (ms); 0 = paused. */
  pollInterval: number;
}

export interface UiLayoutItem {
  id: string;
  visible: boolean;
}

export interface UiLayout {
  /** Ordered overview blocks. Frontend reconciles against its known set. */
  overviewBlocks: UiLayoutItem[];
  /** Ordered sidebar nav items, keyed by route path. */
  navItems: UiLayoutItem[];
}

export interface UiConfig {
  version: typeof UI_CONFIG_VERSION;
  appearance: UiAppearance;
  layout: UiLayout;
}

// ─── Defaults ────────────────────────────────────────────────────────────
// Mirror the pre-existing ThemeContext defaults so an upgrade is a no-op
// visually until the operator changes something.

const DEFAULT_BACKGROUND: UiBackground = {
  type: 'none',
  color: '#0ea5e9',
  gradient: 'none',
  imageOpacity: 0.15,
  imageBlur: 0,
  hasImage: false,
  imageMime: '',
  imageVersion: 0,
};

const DEFAULT_APPEARANCE: UiAppearance = {
  mode: 'system',
  accentMode: 'preset',
  accentPreset: 'sky',
  accentCustom: '#38bdf8',
  accentScope: 'global',
  darkIntensity: 'soft',
  sidebarStyle: 'follow',
  background: DEFAULT_BACKGROUND,
  fontSans: 'default',
  fontMono: 'default',
  uiScale: 1,
  radius: 0.75,
  density: 'cozy',
  reduceMotion: false,
  highContrast: false,
  sidebarDefaultCollapsed: false,
  timeFormat: '24h',
  pollInterval: 3000,
};

const DEFAULT_OVERVIEW_BLOCKS: UiLayoutItem[] = [
  { id: 'stats', visible: true },
  { id: 'connections', visible: true },
  { id: 'alerts', visible: true },
  { id: 'host', visible: true },
  { id: 'sessions', visible: true },
];

const DEFAULT_NAV_ITEMS: UiLayoutItem[] = [
  { id: '/', visible: true },
  { id: '/processes', visible: true },
  { id: '/config', visible: true },
  { id: '/logs', visible: true },
  { id: '/settings', visible: true },
];

export function defaultUiConfig(): UiConfig {
  return {
    version: UI_CONFIG_VERSION,
    appearance: { ...DEFAULT_APPEARANCE, background: { ...DEFAULT_BACKGROUND } },
    layout: {
      overviewBlocks: DEFAULT_OVERVIEW_BLOCKS.map((b) => ({ ...b })),
      navItems: DEFAULT_NAV_ITEMS.map((b) => ({ ...b })),
    },
  };
}

// ─── Normalization helpers ─────────────────────────────────────────────────

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function clampNum(value: unknown, min: number, max: number, fallback: number): number {
  const n = typeof value === 'number' ? value : typeof value === 'string' ? Number(value) : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

function boolOr(value: unknown, fallback: boolean): boolean {
  return typeof value === 'boolean' ? value : fallback;
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
function hexOr(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim() : fallback;
}

/** Bounded free-form id (frontend owns the actual catalogue). */
function idOr(value: unknown, fallback: string, maxLen = 64): string {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (v.length === 0 || v.length > maxLen) return fallback;
  // Ids are slugs / route paths — refuse control chars and anything exotic.
  if (!/^[\w./:-]+$/.test(v)) return fallback;
  return v;
}

function normalizeLayoutItems(value: unknown, fallback: UiLayoutItem[]): UiLayoutItem[] {
  if (!Array.isArray(value)) return fallback.map((i) => ({ ...i }));
  const seen = new Set<string>();
  const out: UiLayoutItem[] = [];
  for (const raw of value) {
    if (!isObject(raw)) continue;
    const id = idOr(raw.id, '');
    if (!id || seen.has(id)) continue;
    seen.add(id);
    out.push({ id, visible: boolOr(raw.visible, true) });
  }
  // An array that parsed to nothing usable is indistinguishable from corrupt;
  // fall back so the frontend always has a baseline to reconcile against.
  return out.length > 0 ? out : fallback.map((i) => ({ ...i }));
}

/**
 * The background-image fields are server-managed (only the upload/delete
 * endpoints mutate them). Normalization NEVER derives them from the value
 * being normalized — the caller supplies the trusted source:
 *   * LOAD path  → the parsed-from-disk file IS the truth (`imageStateFromParsed`).
 *   * SAVE path  → the current on-disk config is the truth (a client payload
 *                  cannot forge `hasImage`).
 */
export interface ServerImageState {
  hasImage: boolean;
  imageMime: string;
  imageVersion: number;
}

const DEFAULT_IMAGE_STATE: ServerImageState = { hasImage: false, imageMime: '', imageVersion: 0 };

const KNOWN_IMAGE_MIMES = ['image/png', 'image/jpeg', 'image/webp'];

/** Coerce a raw background-ish object into a coherent, trusted image state. */
function sanitizeImageState(value: unknown): ServerImageState {
  const v = isObject(value) ? value : {};
  const version = Math.trunc(clampNum(v.imageVersion, 0, Number.MAX_SAFE_INTEGER, 0));
  if (!boolOr(v.hasImage, false)) return { hasImage: false, imageMime: '', imageVersion: version };
  const mime = typeof v.imageMime === 'string' && KNOWN_IMAGE_MIMES.includes(v.imageMime) ? v.imageMime : '';
  // "Has image" with no recognizable mime is incoherent on-disk state; treat
  // it as no image so the serve path and the UI stay consistent.
  if (!mime) return { hasImage: false, imageMime: '', imageVersion: version };
  return { hasImage: true, imageMime: mime, imageVersion: version };
}

/** Trusted image state read FROM a parsed-from-disk config blob. */
function imageStateFromParsed(parsed: unknown): ServerImageState {
  if (!isObject(parsed) || !isObject(parsed.appearance)) return DEFAULT_IMAGE_STATE;
  return sanitizeImageState(parsed.appearance.background);
}

function normalizeBackground(value: unknown, imageState: ServerImageState): UiBackground {
  const v = isObject(value) ? value : {};
  let type = oneOf<BackgroundType>(v.type, ['none', 'solid', 'gradient', 'image'], DEFAULT_BACKGROUND.type);
  // An image background is only valid when an image is actually stored —
  // otherwise the serve route 404s and the UI shows a broken wallpaper.
  if (type === 'image' && !imageState.hasImage) type = 'none';
  return {
    type,
    color: hexOr(v.color, DEFAULT_BACKGROUND.color),
    gradient: idOr(v.gradient, DEFAULT_BACKGROUND.gradient),
    imageOpacity: clampNum(v.imageOpacity, 0, 1, DEFAULT_BACKGROUND.imageOpacity),
    imageBlur: clampNum(v.imageBlur, 0, 40, DEFAULT_BACKGROUND.imageBlur),
    // Server-managed — taken from the caller-supplied trusted source, never
    // from the value being normalized.
    hasImage: imageState.hasImage,
    imageMime: imageState.imageMime,
    imageVersion: imageState.imageVersion,
  };
}

export function normalizeAppearance(value: unknown, imageState: ServerImageState = DEFAULT_IMAGE_STATE): UiAppearance {
  const v = isObject(value) ? value : {};
  return {
    mode: oneOf<ThemeMode>(v.mode, ['light', 'dark', 'system'], DEFAULT_APPEARANCE.mode),
    accentMode: oneOf<AccentMode>(v.accentMode, ['preset', 'custom'], DEFAULT_APPEARANCE.accentMode),
    accentPreset: idOr(v.accentPreset, DEFAULT_APPEARANCE.accentPreset, 32),
    accentCustom: hexOr(v.accentCustom, DEFAULT_APPEARANCE.accentCustom),
    accentScope: oneOf<AccentScope>(v.accentScope, ['sidebar', 'global'], DEFAULT_APPEARANCE.accentScope),
    darkIntensity: oneOf<DarkIntensity>(v.darkIntensity, ['soft', 'black'], DEFAULT_APPEARANCE.darkIntensity),
    sidebarStyle: oneOf<SidebarStyle>(v.sidebarStyle, ['follow', 'panel', 'accent'], DEFAULT_APPEARANCE.sidebarStyle),
    background: normalizeBackground(v.background, imageState),
    fontSans: idOr(v.fontSans, DEFAULT_APPEARANCE.fontSans),
    fontMono: idOr(v.fontMono, DEFAULT_APPEARANCE.fontMono),
    uiScale: clampNum(v.uiScale, 0.9, 1.2, DEFAULT_APPEARANCE.uiScale),
    radius: clampNum(v.radius, 0, 2, DEFAULT_APPEARANCE.radius),
    density: oneOf<Density>(v.density, ['cozy', 'compact'], DEFAULT_APPEARANCE.density),
    reduceMotion: boolOr(v.reduceMotion, DEFAULT_APPEARANCE.reduceMotion),
    highContrast: boolOr(v.highContrast, DEFAULT_APPEARANCE.highContrast),
    sidebarDefaultCollapsed: boolOr(v.sidebarDefaultCollapsed, DEFAULT_APPEARANCE.sidebarDefaultCollapsed),
    timeFormat: oneOf<TimeFormat>(v.timeFormat, ['12h', '24h'], DEFAULT_APPEARANCE.timeFormat),
    pollInterval: clampNum(v.pollInterval, 0, 60_000, DEFAULT_APPEARANCE.pollInterval),
  };
}

export function normalizeUiConfig(value: unknown, imageState: ServerImageState = DEFAULT_IMAGE_STATE): UiConfig {
  const v = isObject(value) ? value : {};
  const layout = isObject(v.layout) ? v.layout : {};
  return {
    version: UI_CONFIG_VERSION,
    appearance: normalizeAppearance(v.appearance, imageState),
    layout: {
      overviewBlocks: normalizeLayoutItems(layout.overviewBlocks, DEFAULT_OVERVIEW_BLOCKS),
      navItems: normalizeLayoutItems(layout.navItems, DEFAULT_NAV_ITEMS),
    },
  };
}

// ─── Persistence ────────────────────────────────────────────────────────────

function ensureConfigDir(): void {
  fs.mkdirSync(CONFIG_DIR, { recursive: true });
}

function atomicWrite(config: UiConfig): void {
  ensureConfigDir();
  const tmp = UI_CONFIG_PATH + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(config, null, 2), 'utf8');
  fs.renameSync(tmp, UI_CONFIG_PATH);
}

let cached: UiConfig | null = null;

/** Load + normalize the UI config, creating it from defaults if absent. */
export function loadUiConfig(): UiConfig {
  if (cached) return cached;
  ensureConfigDir();

  if (!fs.existsSync(UI_CONFIG_PATH)) {
    const fresh = defaultUiConfig();
    try {
      atomicWrite(fresh);
    } catch (err) {
      log.warn('failed to write initial ui.json: %s', err instanceof Error ? err.message : String(err));
    }
    cached = fresh;
    return fresh;
  }

  try {
    const raw = fs.readFileSync(UI_CONFIG_PATH, 'utf8');
    const parsed = JSON.parse(raw) as unknown;
    // On load, the file itself is the source of truth for the server-managed
    // image fields — so they survive restarts (don't reset to defaults).
    const normalized = normalizeUiConfig(parsed, imageStateFromParsed(parsed));
    // Re-persist only if normalization changed something (corrupt/old file),
    // so we self-heal on disk without rewriting on every boot.
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
    log.warn('ui.json unreadable; using defaults: %s', err instanceof Error ? err.message : String(err));
    const fresh = defaultUiConfig();
    cached = fresh;
    return fresh;
  }
}

/**
 * Persist a client-supplied config. The incoming appearance is normalized and
 * its server-managed background-image fields are forced to the current on-disk
 * truth (the client cannot fake `hasImage`). Returns the stored config.
 */
export function saveUiConfig(incoming: unknown): UiConfig {
  const current = loadUiConfig();
  // On save, the current on-disk state is the truth for the server-managed
  // image fields — a client payload cannot forge `hasImage` etc.
  const next = normalizeUiConfig(incoming, current.appearance.background);
  atomicWrite(next);
  cached = next;
  return next;
}

/** The appearance-only subset served unauthenticated to the login page. */
export function publicAppearance(): UiAppearance {
  return loadUiConfig().appearance;
}

// ─── Background image lifecycle ─────────────────────────────────────────────

const IMAGE_MIME: Record<string, string> = {
  png: 'image/png',
  jpeg: 'image/jpeg',
  webp: 'image/webp',
};

/**
 * Identify an image by its magic bytes (never by a client-supplied filename or
 * Content-Type). Returns the canonical MIME, or null if it isn't a supported
 * image. Supported: PNG, JPEG, WebP.
 */
export function sniffImageMime(bytes: Uint8Array): string | null {
  if (bytes.length >= 8 &&
      bytes[0] === 0x89 && bytes[1] === 0x50 && bytes[2] === 0x4e && bytes[3] === 0x47 &&
      bytes[4] === 0x0d && bytes[5] === 0x0a && bytes[6] === 0x1a && bytes[7] === 0x0a) {
    return IMAGE_MIME.png;
  }
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) {
    return IMAGE_MIME.jpeg;
  }
  if (bytes.length >= 12 &&
      bytes[0] === 0x52 && bytes[1] === 0x49 && bytes[2] === 0x46 && bytes[3] === 0x46 &&
      bytes[8] === 0x57 && bytes[9] === 0x45 && bytes[10] === 0x42 && bytes[11] === 0x50) {
    return IMAGE_MIME.webp;
  }
  return null;
}

/** Write the uploaded image to disk and record its metadata. Returns the config. */
export function writeBackgroundImage(bytes: Uint8Array, mime: string): UiConfig {
  fs.mkdirSync(UI_ASSETS_DIR, { recursive: true });
  const tmp = BACKGROUND_IMAGE_PATH + '.tmp';
  fs.writeFileSync(tmp, bytes);
  fs.renameSync(tmp, BACKGROUND_IMAGE_PATH);

  const current = loadUiConfig();
  const next: UiConfig = {
    ...current,
    appearance: {
      ...current.appearance,
      background: {
        ...current.appearance.background,
        // Default to showing the freshly-uploaded image unless the operator
        // explicitly had a non-image background selected and we respect it;
        // switching to 'image' here matches the natural "I just set a wallpaper"
        // expectation.
        type: 'image',
        hasImage: true,
        imageMime: mime,
        imageVersion: current.appearance.background.imageVersion + 1,
      },
    },
  };
  atomicWrite(next);
  cached = next;
  return next;
}

/** Remove the background image (if any) and clear its metadata. Returns the config. */
export function clearBackgroundImage(): UiConfig {
  try {
    if (fs.existsSync(BACKGROUND_IMAGE_PATH)) fs.unlinkSync(BACKGROUND_IMAGE_PATH);
  } catch (err) {
    log.warn('failed to remove background image: %s', err instanceof Error ? err.message : String(err));
  }
  const current = loadUiConfig();
  const next: UiConfig = {
    ...current,
    appearance: {
      ...current.appearance,
      background: {
        ...current.appearance.background,
        // Fall back to 'none' if the image was the active background.
        type: current.appearance.background.type === 'image' ? 'none' : current.appearance.background.type,
        hasImage: false,
        imageMime: '',
      },
    },
  };
  atomicWrite(next);
  cached = next;
  return next;
}

/** Read the background image bytes + MIME, or null if none is stored. */
export function readBackgroundImage(): { bytes: Buffer; mime: string } | null {
  const { background } = loadUiConfig().appearance;
  if (!background.hasImage) return null;
  try {
    const bytes = fs.readFileSync(BACKGROUND_IMAGE_PATH);
    return { bytes, mime: background.imageMime || 'application/octet-stream' };
  } catch {
    return null;
  }
}
