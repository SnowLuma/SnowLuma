import { boolOr, clampInt, clampNum, isObject } from '@snowluma/common/coerce';
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
/** Full color scheme. 'default' keeps the sky theme (driven by `mode`); the
 *  Catppuccin flavors are complete palettes that also fix light/dark. */
export type Palette =
  | 'default'
  | 'catppuccin-latte' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha'
  | 'rose-pine' | 'rose-pine-moon' | 'rose-pine-dawn'
  | 'nord'
  | 'everforest-dark' | 'everforest-light';

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
  /** Full color scheme; 'default' = the built-in sky theme. */
  palette: Palette;
  sidebarStyle: SidebarStyle;
  background: UiBackground;
  /** Sans font preset id (frontend catalogue); 'custom' uses `fontSansCustom`. */
  fontSans: string;
  /** Free-form sans font-family stack, used when `fontSans === 'custom'`. */
  fontSansCustom: string;
  /** Mono font preset id (frontend catalogue); 'custom' uses `fontMonoCustom`. */
  fontMono: string;
  /** Free-form mono font-family stack, used when `fontMono === 'custom'`. */
  fontMonoCustom: string;
  /** Global UI scale, 0.9…1.2. */
  uiScale: number;
  /** Corner radius in rem, 0…2. */
  radius: number;
  density: Density;
  /** Soften animations (transforms off, shorter durations). */
  reduceMotion: boolean;
  /** Hard-disable all UI animations (stronger than reduceMotion). */
  disableMotion: boolean;
  highContrast: boolean;
  sidebarPinned: boolean;
  timeFormat: TimeFormat;
  /** Dashboard poll interval (ms); 0 = paused. */
  pollInterval: number;
  /**
   * Operator custom CSS, applied AFTER auth only (never on the login page —
   * `publicAppearance` strips it). Capped at 50 KB. The client injects it as
   * the last <style> and skips it under `?safe-mode=1` so a broken rule can't
   * lock the operator out.
   */
  customCss: string;
  /**
   * Theme-token overrides from the variable panel. Keys are restricted to a
   * fixed whitelist of `--token` names and values to colours / lengths, so
   * (unlike `customCss`) this is safe to serve to the unauthenticated login
   * page — `normalizeAppearance` drops unknown keys and invalid values.
   */
  cssVars: Record<string, string>;
}

export interface UiLayoutItem {
  id: string;
  visible: boolean;
  /**
   * Grid position/size (overview blocks only; nav items omit them). The
   * client owns the widget catalogue, per-widget min sizes, and the
   * `stats`→tiles migration — the server just preserves + clamps these to
   * sane integer bounds so a corrupt file can't store absurd coords.
   */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /**
   * Per-widget settings (overview blocks only) — an opaque object the client
   * interprets by widget type (e.g. alerts: count + levels). The server only
   * checks it's a plain object within a size bound; it never reads the keys.
   */
  config?: Record<string, unknown>;
}

export interface UiLayout {
  /** Ordered overview blocks (desktop 2D grid). Frontend reconciles vs its set. */
  overviewBlocks: UiLayoutItem[];
  /** Ordered single-column mobile overview (id+visible only; the 2D grid is
   *  desktop-only). Kept separate so phone ordering never pollutes the grid. */
  overviewMobile: UiLayoutItem[];
  /** Ordered sidebar nav items, keyed by route path. */
  navItems: UiLayoutItem[];
  /** Top-bar element show/hide list (id+visible), mirroring navItems' shape. */
  topbarItems: UiLayoutItem[];
}

export interface UiHighlightRule {
  keyword: string;
  color: string;
}

export type LogsPreset = 'dev' | 'ops' | 'minimal' | 'custom';

export interface UiLogsPrefs {
  /** Log levels shown by default (client display filter). */
  visibleLevels: string[];
  /** Ring-buffer cap for the live view (100…5000). */
  maxLines: number;
  autoScroll: boolean;
  wrap: boolean;
  /** Keyword → colour row highlights. */
  highlightRules: UiHighlightRule[];
  /** Active view preset id; 'custom' = the operator hand-tuned the prefs. The
   *  client owns the preset → prefs bundles; the server just stores the id. */
  preset: LogsPreset;
}

export interface UiPages {
  /** Route the operator lands on after login (a nav path; '/' if unset). */
  defaultRoute: string;
  logs: UiLogsPrefs;
  /** Default sort key for the processes page. */
  processesSort: string;
  /** Default tab id for the node-config page ('' = first). */
  configTab: string;
}

export interface UiConfig {
  version: typeof UI_CONFIG_VERSION;
  appearance: UiAppearance;
  layout: UiLayout;
  pages: UiPages;
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
  palette: 'default',
  sidebarStyle: 'follow',
  background: DEFAULT_BACKGROUND,
  fontSans: 'default',
  fontSansCustom: '',
  fontMono: 'default',
  fontMonoCustom: '',
  uiScale: 1,
  radius: 0.75,
  density: 'cozy',
  reduceMotion: false,
  disableMotion: false,
  highContrast: false,
  sidebarPinned: false,
  timeFormat: '24h',
  pollInterval: 3000,
  customCss: '',
  cssVars: {},
};

const DEFAULT_OVERVIEW_BLOCKS: UiLayoutItem[] = [
  { id: 'stats', visible: true },
  { id: 'connections', visible: true },
  { id: 'alerts', visible: true },
  { id: 'host', visible: true },
  { id: 'sessions', visible: true },
];

// Single-column mobile order = the desktop grid catalogue's widgets, flattened
// (stat tiles, then the cards). The client reconciles against its real
// catalogue, so this just seeds first run; unknown ids are dropped on load.
const DEFAULT_OVERVIEW_MOBILE: UiLayoutItem[] = [
  { id: 'stat:status', visible: true },
  { id: 'stat:accounts', visible: true },
  { id: 'stat:processes', visible: true },
  { id: 'stat:host', visible: true },
  { id: 'stat:uptime', visible: true },
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

// Toggleable top-bar elements (essential ones — menu, page title, logout — are
// pinned in the client and never appear here). The client reconciles, so a new
// element (e.g. the kiosk button) just appears as visible.
const DEFAULT_TOPBAR_ITEMS: UiLayoutItem[] = [
  { id: 'status', visible: true },
  { id: 'theme', visible: true },
  { id: 'kiosk', visible: true },
];

const LOG_LEVELS = ['trace', 'debug', 'info', 'success', 'warn', 'error'];

const DEFAULT_PAGES: UiPages = {
  defaultRoute: '/',
  logs: {
    visibleLevels: [...LOG_LEVELS],
    maxLines: 1000,
    autoScroll: true,
    wrap: true,
    highlightRules: [],
    preset: 'custom',
  },
  processesSort: 'pid',
  configTab: '',
};

export function defaultUiConfig(): UiConfig {
  return {
    version: UI_CONFIG_VERSION,
    appearance: { ...DEFAULT_APPEARANCE, background: { ...DEFAULT_BACKGROUND }, cssVars: {} },
    layout: {
      overviewBlocks: DEFAULT_OVERVIEW_BLOCKS.map((b) => ({ ...b })),
      overviewMobile: DEFAULT_OVERVIEW_MOBILE.map((b) => ({ ...b })),
      navItems: DEFAULT_NAV_ITEMS.map((b) => ({ ...b })),
      topbarItems: DEFAULT_TOPBAR_ITEMS.map((b) => ({ ...b })),
    },
    pages: defaultPages(),
  };
}

function defaultPages(): UiPages {
  return { ...DEFAULT_PAGES, logs: { ...DEFAULT_PAGES.logs, visibleLevels: [...LOG_LEVELS], highlightRules: [] } };
}

// ─── Normalization helpers ─────────────────────────────────────────────────
// isObject / boolOr / clampNum / clampInt come from @snowluma/common/coerce.
// oneOf (enum), isFiniteNum, and hexOr (CSS color) are ui-specific and stay.

function oneOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function isFiniteNum(value: unknown): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  return typeof value === 'string' && value.trim() !== '' && Number.isFinite(Number(value));
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

/**
 * A free-form font-family value (a single family or a comma-separated stack),
 * safe to interpolate into `--font-sans: <value>;`. Allows letters (incl. CJK),
 * digits, spaces and the punctuation real font names use, but refuses anything
 * that could break out of the declaration (`;`, `{`, `}`, control chars, etc.).
 * Empty / over-long / invalid → fallback ('' = "no custom family set").
 */
const FONT_FAMILY_RE = /^[\p{L}\p{N}\s,'"._-]+$/u;
function fontFamilyOr(value: unknown, fallback: string, maxLen = 200): string {
  if (typeof value !== 'string') return fallback;
  const v = value.trim();
  if (v.length === 0) return ''; // explicitly cleared
  if (v.length > maxLen || !FONT_FAMILY_RE.test(v)) return fallback;
  return v;
}

// ─── cssVars (theme-token override panel) ──────────────────────────────────
// Both the keys (which `--token` may be set) and the values (colour / length)
// are whitelisted so the result is safe to serve to the UNAUTHENTICATED login
// page — it shares the trust level of palette/accent, not of `customCss`.

/** The `--token` names the variable panel is allowed to override. Kept in sync
 *  with the surface/accent tokens `ThemeContext` actually injects. */
const CSS_VAR_WHITELIST = new Set<string>([
  '--background', '--foreground',
  '--card', '--card-foreground',
  '--popover', '--popover-foreground',
  '--primary', '--primary-foreground',
  '--secondary', '--secondary-foreground',
  '--muted', '--muted-foreground',
  '--accent', '--accent-foreground',
  '--destructive', '--destructive-foreground',
  '--success', '--warning',
  '--border', '--input', '--ring',
  '--sidebar', '--sidebar-foreground',
  '--sidebar-primary', '--sidebar-primary-foreground',
  '--sidebar-accent', '--sidebar-accent-foreground',
  '--sidebar-border', '--sidebar-ring',
]);

// A CSS colour value, restricted to forms that cannot break out of a `--token:
// <value>;` declaration. Hex, a named colour, or a single balanced functional
// notation (rgb/hsl/oklch/… and color-mix) over a safe char set — crucially no
// `;`, `{`, `}`, `:` or angle brackets are permitted anywhere.
const CSS_HEX_RE = /^#(?:[0-9a-fA-F]{3,4}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;
const CSS_NAMED_RE = /^[a-zA-Z]{1,24}$/;
const CSS_FUNC_RE = /^(?:rgb|rgba|hsl|hsla|hwb|lab|lch|oklab|oklch|color|color-mix)\([a-zA-Z0-9.,%/\s#-]{1,120}\)$/;
function cssColorOrNull(value: unknown): string | null {
  if (typeof value !== 'string') return null;
  const v = value.trim();
  if (v.length === 0 || v.length > 128) return null;
  if (CSS_HEX_RE.test(v) || CSS_NAMED_RE.test(v) || CSS_FUNC_RE.test(v)) return v;
  return null;
}

/** Keep only whitelisted token keys with valid colour values; drop the rest. */
function normalizeCssVars(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  const out: Record<string, string> = {};
  for (const key of Object.keys(value)) {
    if (!CSS_VAR_WHITELIST.has(key)) continue;
    const color = cssColorOrNull(value[key]);
    if (color) out[key] = color;
  }
  return out;
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
    const item: UiLayoutItem = { id, visible: boolOr(raw.visible, true) };
    // Grid coords are optional (overview blocks carry them; nav items don't).
    // Preserve + clamp when any are present; missing ones get safe defaults
    // and the client re-applies per-widget min sizes on load.
    if (isFiniteNum(raw.x) || isFiniteNum(raw.y) || isFiniteNum(raw.w) || isFiniteNum(raw.h)) {
      item.x = clampInt(raw.x, 0, 50, 0);
      item.y = clampInt(raw.y, 0, 1000, 0);
      item.w = clampInt(raw.w, 1, 12, 1);
      item.h = clampInt(raw.h, 1, 100, 1);
    }
    // Opaque per-widget config: keep only a plain object within a size bound;
    // the server never interprets the keys (the client does, per widget type).
    if (isObject(raw.config)) {
      try {
        if (JSON.stringify(raw.config).length <= 4096) item.config = raw.config;
      } catch { /* unserializable (cycles) → drop */ }
    }
    out.push(item);
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
    palette: oneOf<Palette>(v.palette, ['default', 'catppuccin-latte', 'catppuccin-frappe', 'catppuccin-macchiato', 'catppuccin-mocha', 'rose-pine', 'rose-pine-moon', 'rose-pine-dawn', 'nord', 'everforest-dark', 'everforest-light'], DEFAULT_APPEARANCE.palette),
    sidebarStyle: oneOf<SidebarStyle>(v.sidebarStyle, ['follow', 'panel', 'accent'], DEFAULT_APPEARANCE.sidebarStyle),
    background: normalizeBackground(v.background, imageState),
    fontSans: idOr(v.fontSans, DEFAULT_APPEARANCE.fontSans),
    fontSansCustom: fontFamilyOr(v.fontSansCustom, DEFAULT_APPEARANCE.fontSansCustom),
    fontMono: idOr(v.fontMono, DEFAULT_APPEARANCE.fontMono),
    fontMonoCustom: fontFamilyOr(v.fontMonoCustom, DEFAULT_APPEARANCE.fontMonoCustom),
    uiScale: clampNum(v.uiScale, 0.9, 1.2, DEFAULT_APPEARANCE.uiScale),
    radius: clampNum(v.radius, 0, 2, DEFAULT_APPEARANCE.radius),
    density: oneOf<Density>(v.density, ['cozy', 'compact'], DEFAULT_APPEARANCE.density),
    reduceMotion: boolOr(v.reduceMotion, DEFAULT_APPEARANCE.reduceMotion),
    disableMotion: boolOr(v.disableMotion, DEFAULT_APPEARANCE.disableMotion),
    highContrast: boolOr(v.highContrast, DEFAULT_APPEARANCE.highContrast),
    sidebarPinned: boolOr(v.sidebarPinned, DEFAULT_APPEARANCE.sidebarPinned),
    timeFormat: oneOf<TimeFormat>(v.timeFormat, ['12h', '24h'], DEFAULT_APPEARANCE.timeFormat),
    pollInterval: clampNum(v.pollInterval, 0, 60_000, DEFAULT_APPEARANCE.pollInterval),
    customCss: typeof v.customCss === 'string' ? v.customCss.slice(0, 50_000) : DEFAULT_APPEARANCE.customCss,
    cssVars: normalizeCssVars(v.cssVars),
  };
}

export function normalizeLayout(value: unknown): UiLayout {
  const layout = isObject(value) ? value : {};
  return {
    overviewBlocks: normalizeLayoutItems(layout.overviewBlocks, DEFAULT_OVERVIEW_BLOCKS),
    overviewMobile: normalizeLayoutItems(layout.overviewMobile, DEFAULT_OVERVIEW_MOBILE),
    navItems: normalizeLayoutItems(layout.navItems, DEFAULT_NAV_ITEMS),
    topbarItems: normalizeLayoutItems(layout.topbarItems, DEFAULT_TOPBAR_ITEMS),
  };
}

function normalizeHighlightRules(value: unknown): UiHighlightRule[] {
  if (!Array.isArray(value)) return [];
  const out: UiHighlightRule[] = [];
  for (const raw of value) {
    if (!isObject(raw) || typeof raw.keyword !== 'string') continue;
    const keyword = raw.keyword.trim().slice(0, 50);
    if (!keyword) continue; // drop empty / whitespace-only (would match every row)
    const color = typeof raw.color === 'string' ? raw.color.slice(0, 32) : '';
    out.push({ keyword, color });
    if (out.length >= 20) break; // cap the rule count
  }
  return out;
}

export function normalizePages(value: unknown): UiPages {
  const v = isObject(value) ? value : {};
  const logs = isObject(v.logs) ? v.logs : {};
  const levels = Array.isArray(logs.visibleLevels)
    ? LOG_LEVELS.filter((l) => (logs.visibleLevels as unknown[]).includes(l))
    : DEFAULT_PAGES.logs.visibleLevels;
  return {
    defaultRoute: idOr(v.defaultRoute, DEFAULT_PAGES.defaultRoute),
    logs: {
      visibleLevels: levels.length > 0 ? levels : [...LOG_LEVELS],
      maxLines: clampInt(logs.maxLines, 100, 5000, DEFAULT_PAGES.logs.maxLines),
      autoScroll: boolOr(logs.autoScroll, DEFAULT_PAGES.logs.autoScroll),
      wrap: boolOr(logs.wrap, DEFAULT_PAGES.logs.wrap),
      highlightRules: normalizeHighlightRules(logs.highlightRules),
      preset: oneOf<LogsPreset>(logs.preset, ['dev', 'ops', 'minimal', 'custom'], 'custom'),
    },
    processesSort: idOr(v.processesSort, DEFAULT_PAGES.processesSort),
    configTab: typeof v.configTab === 'string' ? v.configTab.slice(0, 64) : DEFAULT_PAGES.configTab,
  };
}

export function normalizeUiConfig(value: unknown, imageState: ServerImageState = DEFAULT_IMAGE_STATE): UiConfig {
  const v = isObject(value) ? value : {};
  return {
    version: UI_CONFIG_VERSION,
    appearance: normalizeAppearance(v.appearance, imageState),
    layout: normalizeLayout(v.layout),
    pages: normalizePages(v.pages),
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
  const v = isObject(incoming) ? incoming : {};
  // Section-level merge: a payload may carry just `appearance` (the theme
  // editor) or just `layout` (the layout editor) without clobbering the
  // other. A missing/non-object section keeps the current on-disk value.
  // The current on-disk state is the truth for the server-managed image
  // fields — a client payload cannot forge `hasImage` etc.
  const next: UiConfig = {
    version: UI_CONFIG_VERSION,
    appearance: isObject(v.appearance)
      ? normalizeAppearance(v.appearance, current.appearance.background)
      : current.appearance,
    layout: isObject(v.layout) ? normalizeLayout(v.layout) : current.layout,
    pages: isObject(v.pages) ? normalizePages(v.pages) : (current.pages ?? defaultPages()),
  };
  atomicWrite(next);
  cached = next;
  return next;
}

/** The appearance subset served unauthenticated to the login page. Strips
 *  `customCss` so a broken/hostile rule can never reach the pre-auth page
 *  (and so the operator can always log in to fix it). */
export function publicAppearance(): UiAppearance {
  return { ...loadUiConfig().appearance, customCss: '' };
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
