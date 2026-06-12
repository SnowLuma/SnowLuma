import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { MotionConfig } from 'motion/react';
import type { ThemeMode, UiAppearance, UiBackground } from '@/types';

// Re-export the appearance value types so consumers (settings page etc.) can
// import them straight from the context module.
export type {
  AccentMode, AccentScope, BackgroundType, DarkIntensity, Density, SidebarStyle, ThemeMode, TimeFormat, UiAppearance,
} from '@/types';

/** A partial appearance update; `background` may itself be a partial patch. */
export type AppearancePatch = Partial<Omit<UiAppearance, 'background'>> & { background?: Partial<UiBackground> };

// ─── Frontend catalogues (the server stores only ids; the visuals live here) ───

export type AccentColor = 'sky' | 'blue' | 'violet' | 'rose' | 'emerald' | 'amber' | 'orange';

export interface AccentSpec {
  id: AccentColor;
  label: string;
  swatch: string;
  light: { primary: string; ring: string };
  dark: { primary: string; ring: string };
}

export const ACCENTS: AccentSpec[] = [
  { id: 'sky', label: '天蓝', swatch: '#38bdf8',
    light: { primary: 'oklch(68.5% 0.155 230)', ring: 'oklch(68.5% 0.155 230)' },
    dark: { primary: 'oklch(75% 0.14 230)', ring: 'oklch(75% 0.14 230)' } },
  { id: 'blue', label: '靛蓝', swatch: '#3b82f6',
    light: { primary: 'oklch(60% 0.18 258)', ring: 'oklch(60% 0.18 258)' },
    dark: { primary: 'oklch(70% 0.16 258)', ring: 'oklch(70% 0.16 258)' } },
  { id: 'violet', label: '紫罗兰', swatch: '#8b5cf6',
    light: { primary: 'oklch(60% 0.2 290)', ring: 'oklch(60% 0.2 290)' },
    dark: { primary: 'oklch(72% 0.17 290)', ring: 'oklch(72% 0.17 290)' } },
  { id: 'rose', label: '玫瑰', swatch: '#f43f5e',
    light: { primary: 'oklch(63% 0.21 18)', ring: 'oklch(63% 0.21 18)' },
    dark: { primary: 'oklch(72% 0.18 18)', ring: 'oklch(72% 0.18 18)' } },
  { id: 'emerald', label: '翡翠', swatch: '#10b981',
    light: { primary: 'oklch(64% 0.16 162)', ring: 'oklch(64% 0.16 162)' },
    dark: { primary: 'oklch(74% 0.15 162)', ring: 'oklch(74% 0.15 162)' } },
  { id: 'amber', label: '琥珀', swatch: '#f59e0b',
    light: { primary: 'oklch(72% 0.17 70)', ring: 'oklch(72% 0.17 70)' },
    dark: { primary: 'oklch(78% 0.16 70)', ring: 'oklch(78% 0.16 70)' } },
  { id: 'orange', label: '夕橙', swatch: '#f97316',
    light: { primary: 'oklch(67% 0.2 45)', ring: 'oklch(67% 0.2 45)' },
    dark: { primary: 'oklch(74% 0.18 45)', ring: 'oklch(74% 0.18 45)' } },
];

export const RADIUS_OPTIONS = [
  { value: 0.375, label: '紧凑' },
  { value: 0.5, label: '默认' },
  { value: 0.75, label: '舒适' },
  { value: 1.0, label: '圆润' },
] as const;

export const POLL_INTERVAL_OPTIONS = [
  { value: 1000, label: '1 秒（实时）' },
  { value: 3000, label: '3 秒（默认）' },
  { value: 5000, label: '5 秒（节能）' },
  { value: 10000, label: '10 秒（省电）' },
  { value: 0, label: '已暂停' },
] as const;

export interface FontSpec { id: string; label: string; stack: string }

export const FONT_SANS_OPTIONS: FontSpec[] = [
  { id: 'default', label: '默认 (Inter)', stack: "'Inter', 'Noto Sans SC', system-ui, -apple-system, sans-serif" },
  { id: 'system', label: '系统界面', stack: "system-ui, -apple-system, 'Segoe UI', 'Noto Sans SC', sans-serif" },
  { id: 'rounded', label: '圆润', stack: "'Varela Round', 'Quicksand', 'Noto Sans SC', system-ui, sans-serif" },
  { id: 'serif', label: '衬线', stack: "Georgia, 'Songti SC', 'Noto Serif SC', serif" },
];

export const FONT_MONO_OPTIONS: FontSpec[] = [
  { id: 'default', label: '默认 (JetBrains)', stack: "'JetBrains Mono', 'Fira Code', ui-monospace, monospace" },
  { id: 'system', label: '系统等宽', stack: "ui-monospace, 'SF Mono', Menlo, Consolas, monospace" },
];

export interface GradientSpec { id: string; label: string; css: string }

export const GRADIENT_OPTIONS: GradientSpec[] = [
  { id: 'aurora', label: '极光', css: 'linear-gradient(135deg, #1e3a8a 0%, #0ea5e9 50%, #22d3ee 100%)' },
  { id: 'sunset', label: '日落', css: 'linear-gradient(135deg, #f97316 0%, #db2777 50%, #7c3aed 100%)' },
  { id: 'forest', label: '森野', css: 'linear-gradient(135deg, #064e3b 0%, #10b981 55%, #84cc16 100%)' },
  { id: 'dusk', label: '暮色', css: 'linear-gradient(160deg, #0f172a 0%, #334155 55%, #64748b 100%)' },
  { id: 'rose', label: '霞光', css: 'linear-gradient(135deg, #9f1239 0%, #fb7185 55%, #fda4af 100%)' },
];

export const UI_SCALE = { min: 0.9, max: 1.2, step: 0.05 } as const;

// ─── Defaults (mirror core/src/webui/ui-config.ts) ─────────────────────────

export const DEFAULT_APPEARANCE: UiAppearance = {
  mode: 'system',
  accentMode: 'preset',
  accentPreset: 'sky',
  accentCustom: '#38bdf8',
  accentScope: 'global',
  darkIntensity: 'soft',
  sidebarStyle: 'follow',
  background: { type: 'none', color: '#0ea5e9', gradient: 'none', imageOpacity: 0.15, imageBlur: 0, hasImage: false, imageMime: '', imageVersion: 0 },
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

const LS_CACHE = 'snowluma_ui_appearance';
const LS_MIGRATED = 'snowluma_ui_migrated';
const TOKEN_KEY = 'snowluma_token';

// ─── Colour helpers (custom hex accent → readable foreground) ──────────────

function hexToRgb(hex: string): { r: number; g: number; b: number } | null {
  const m = hex.trim().replace('#', '');
  if (m.length === 3) {
    const r = parseInt(m[0] + m[0], 16), g = parseInt(m[1] + m[1], 16), b = parseInt(m[2] + m[2], 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  if (m.length === 6 || m.length === 8) {
    const r = parseInt(m.slice(0, 2), 16), g = parseInt(m.slice(2, 4), 16), b = parseInt(m.slice(4, 6), 16);
    return Number.isNaN(r + g + b) ? null : { r, g, b };
  }
  return null;
}

/** Pick black or white text for a given accent so labels stay legible. */
function readableForeground(hex: string): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return '#ffffff';
  // Relative luminance (sRGB approximation).
  const lum = (0.2126 * rgb.r + 0.7152 * rgb.g + 0.0722 * rgb.b) / 255;
  return lum > 0.6 ? '#0b0d12' : '#ffffff';
}

const HEX_RE = /^#(?:[0-9a-fA-F]{3}|[0-9a-fA-F]{6}|[0-9a-fA-F]{8})$/;

/** A hex colour safe to interpolate into CSS text, else the fallback. Guards
 *  the localStorage cache (writable by anyone with local access) from
 *  injecting arbitrary CSS through the accent <style> block. */
function safeHex(value: unknown, fallback: string): string {
  return typeof value === 'string' && HEX_RE.test(value.trim()) ? value.trim() : fallback;
}

/** Lighten a hex colour toward white by `ratio` (0..1) for dark-mode accents. */
function lightenHex(hex: string, ratio: number): string {
  const rgb = hexToRgb(hex);
  if (!rgb) return hex;
  const mix = (c: number) => Math.round(c + (255 - c) * ratio);
  const to2 = (n: number) => n.toString(16).padStart(2, '0');
  return `#${to2(mix(rgb.r))}${to2(mix(rgb.g))}${to2(mix(rgb.b))}`;
}

// ─── Apply appearance → DOM ────────────────────────────────────────────────

function accentVarsCss(a: UiAppearance): string {
  if (a.accentMode === 'custom') {
    const hex = safeHex(a.accentCustom, '#38bdf8');
    const lightFg = readableForeground(hex);
    // Dark mode: lighten the accent for contrast on dark surfaces, and pick
    // the foreground from the *lightened* colour (a light accent needs dark text).
    const darkHex = lightenHex(hex, 0.18);
    const darkFg = readableForeground(darkHex);
    const lightBlock = a.accentScope === 'global'
      ? `--primary:${hex};--primary-foreground:${lightFg};--ring:${hex};--sidebar-primary:${hex};--sidebar-primary-foreground:${lightFg};--sidebar-ring:${hex};`
      : `--sidebar-primary:${hex};--sidebar-primary-foreground:${lightFg};--sidebar-ring:${hex};`;
    const darkBlock = a.accentScope === 'global'
      ? `--primary:${darkHex};--primary-foreground:${darkFg};--ring:${darkHex};--sidebar-primary:${darkHex};--sidebar-primary-foreground:${darkFg};--sidebar-ring:${darkHex};`
      : `--sidebar-primary:${darkHex};--sidebar-primary-foreground:${darkFg};--sidebar-ring:${darkHex};`;
    return `:root{${lightBlock}}\n.dark{${darkBlock}}`;
  }
  const spec = ACCENTS.find((x) => x.id === a.accentPreset) ?? ACCENTS[0];
  const light = a.accentScope === 'global'
    ? `--primary:${spec.light.primary};--ring:${spec.light.ring};--sidebar-primary:${spec.light.primary};--sidebar-ring:${spec.light.ring};`
    : `--sidebar-primary:${spec.light.primary};--sidebar-ring:${spec.light.ring};`;
  const dark = a.accentScope === 'global'
    ? `--primary:${spec.dark.primary};--ring:${spec.dark.ring};--sidebar-primary:${spec.dark.primary};--sidebar-ring:${spec.dark.ring};`
    : `--sidebar-primary:${spec.dark.primary};--sidebar-ring:${spec.dark.ring};`;
  // Presets keep the base token's primary-foreground (designed for these hues).
  return `:root{${light}}\n.dark{${dark}}`;
}

function fontStack(options: FontSpec[], id: string): string {
  return (options.find((f) => f.id === id) ?? options[0]).stack;
}

function applyAppearance(a: UiAppearance, resolved: 'light' | 'dark'): void {
  const root = document.documentElement;

  root.classList.remove('light', 'dark');
  root.classList.add(resolved);
  root.setAttribute('data-theme', resolved);
  root.style.colorScheme = resolved;

  root.setAttribute('data-density', a.density);
  root.setAttribute('data-dark-intensity', a.darkIntensity);
  root.setAttribute('data-sidebar-style', a.sidebarStyle);
  root.setAttribute('data-contrast', a.highContrast ? 'high' : 'normal');
  root.setAttribute('data-reduce-motion', a.reduceMotion ? '1' : '0');

  // Mode-independent vars go inline on :root.
  root.style.setProperty('--radius', `${a.radius}rem`);
  root.style.setProperty('--font-sans', fontStack(FONT_SANS_OPTIONS, a.fontSans));
  root.style.setProperty('--font-mono', fontStack(FONT_MONO_OPTIONS, a.fontMono));
  // UI scale: scale the root font-size so all rem-based sizing tracks it.
  // Clamp defensively (the localStorage cache is locally tamperable; the
  // server already bounds this to 0.9..1.2 for its own values).
  const scale = Math.min(2, Math.max(0.5, Number.isFinite(a.uiScale) ? a.uiScale : 1));
  root.style.fontSize = `${Math.round(16 * scale * 100) / 100}px`;

  // Accent differs by light/dark, so it needs a stylesheet with a `.dark` rule.
  const styleId = 'snowluma-theme-overrides';
  let el = document.getElementById(styleId) as HTMLStyleElement | null;
  if (!el) {
    el = document.createElement('style');
    el.id = styleId;
    document.head.appendChild(el);
  }
  el.textContent = accentVarsCss(a);
}

/** Manage the fixed full-viewport background layer behind the app. */
function applyBackgroundLayer(a: UiAppearance): void {
  const id = 'snowluma-bg-layer';
  let layer = document.getElementById(id) as HTMLDivElement | null;
  const bg = a.background;

  if (bg.type === 'none') {
    if (layer) layer.style.display = 'none';
    return;
  }
  if (!layer) {
    layer = document.createElement('div');
    layer.id = id;
    layer.setAttribute('aria-hidden', 'true');
    // Behind app content, ignores pointer events, fixed to the viewport.
    layer.style.position = 'fixed';
    layer.style.inset = '0';
    layer.style.zIndex = '-1';
    layer.style.pointerEvents = 'none';
    layer.style.backgroundSize = 'cover';
    layer.style.backgroundPosition = 'center';
    layer.style.backgroundRepeat = 'no-repeat';
    document.body.insertBefore(layer, document.body.firstChild);
  }
  layer.style.display = 'block';
  layer.style.filter = '';
  layer.style.transform = '';

  if (bg.type === 'solid') {
    layer.style.backgroundColor = bg.color;
    layer.style.backgroundImage = 'none';
  } else if (bg.type === 'gradient') {
    const g = GRADIENT_OPTIONS.find((x) => x.id === bg.gradient) ?? GRADIENT_OPTIONS[0];
    layer.style.backgroundColor = 'transparent';
    layer.style.backgroundImage = g.css;
  } else if (bg.type === 'image' && bg.hasImage) {
    // Overlay (for readability) layered over the image; opacity 0..1 = how
    // strongly the base background colour masks the wallpaper.
    const overlay = `color-mix(in oklab, var(--background) ${Math.round(bg.imageOpacity * 100)}%, transparent)`;
    layer.style.backgroundColor = 'transparent';
    layer.style.backgroundImage = `linear-gradient(${overlay}, ${overlay}), url("/ui-asset/background?v=${bg.imageVersion}")`;
    if (bg.imageBlur > 0) {
      layer.style.filter = `blur(${bg.imageBlur}px)`;
      // Scale up so the blurred edges don't reveal the viewport border.
      layer.style.transform = 'scale(1.06)';
    }
  } else {
    // type === 'image' but no image on disk → nothing to show.
    layer.style.display = 'none';
  }
}

// ─── Server transport (ThemeProvider sits outside ApiProvider, so it uses a
//     direct fetch with the bearer token from localStorage) ─────────────────

function authToken(): string | null {
  try { return localStorage.getItem(TOKEN_KEY); } catch { return null; }
}

async function fetchAppearance(): Promise<UiAppearance | null> {
  try {
    const res = await fetch('/api/ui/public');
    if (!res.ok) return null;
    const data = (await res.json()) as { appearance?: UiAppearance };
    return data.appearance ?? null;
  } catch {
    return null;
  }
}

async function persistAppearance(appearance: UiAppearance): Promise<void> {
  const token = authToken();
  if (!token) return; // pre-auth: local cache only (no settings UI exists there anyway)
  try {
    await fetch('/api/ui', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${token}` },
      // Section-level save: only `appearance`; the server preserves `layout`.
      body: JSON.stringify({ appearance }),
    });
  } catch {
    /* best-effort — the local cache already holds the change */
  }
}

// ─── Migration of the pre-server-config localStorage theme ─────────────────

function readLegacyOverlay(): Partial<UiAppearance> | null {
  try {
    const out: Partial<UiAppearance> = {};
    const mode = localStorage.getItem('snowluma_theme');
    if (mode === 'light' || mode === 'dark' || mode === 'system') out.mode = mode;
    const accent = localStorage.getItem('snowluma_accent');
    if (accent && ACCENTS.some((a) => a.id === accent)) { out.accentMode = 'preset'; out.accentPreset = accent; }
    const radius = Number(localStorage.getItem('snowluma_radius'));
    if (Number.isFinite(radius) && radius > 0 && radius <= 2) out.radius = radius;
    const density = localStorage.getItem('snowluma_density');
    if (density === 'cozy' || density === 'compact') out.density = density;
    const poll = Number(localStorage.getItem('snowluma_poll_interval'));
    if (Number.isFinite(poll) && poll >= 0 && poll <= 60_000) out.pollInterval = poll;
    return Object.keys(out).length > 0 ? out : null;
  } catch {
    return null;
  }
}

function isPristine(a: UiAppearance): boolean {
  const d = DEFAULT_APPEARANCE;
  return a.mode === d.mode && a.accentMode === d.accentMode && a.accentPreset === d.accentPreset
    && a.radius === d.radius && a.density === d.density && a.pollInterval === d.pollInterval
    && a.background.type === 'none';
}

function readCache(): UiAppearance {
  try {
    const raw = localStorage.getItem(LS_CACHE);
    if (!raw) return DEFAULT_APPEARANCE;
    const parsed = JSON.parse(raw) as Partial<UiAppearance>;
    // Shallow merge over defaults so a cache written by an older build still
    // yields a complete object (the server is the real validator).
    return { ...DEFAULT_APPEARANCE, ...parsed, background: { ...DEFAULT_APPEARANCE.background, ...parsed.background } };
  } catch {
    return DEFAULT_APPEARANCE;
  }
}

function writeCache(a: UiAppearance): void {
  try { localStorage.setItem(LS_CACHE, JSON.stringify(a)); } catch { /* quota / private mode */ }
}

// ─── Context ───────────────────────────────────────────────────────────────

interface ThemeContextValue {
  appearance: UiAppearance;
  /** True once the first server load attempt has resolved. */
  ready: boolean;
  resolved: 'light' | 'dark';
  /** Merge a partial appearance: applies instantly, caches, debounced-persists. */
  setAppearance: (patch: AppearancePatch) => void;
  /** Upload a wallpaper (PNG/JPEG/WebP, ≤5MB). Throws on failure. */
  uploadBackground: (file: File) => Promise<void>;
  /** Remove the wallpaper. */
  removeBackground: () => Promise<void>;
  /** Format a timestamp per the configured 12h/24h preference. */
  formatClock: (input: string | number | Date) => string;
  // ── back-compat conveniences ──
  mode: ThemeMode;
  setMode: (m: ThemeMode) => void;
  pollInterval: number;
}

const ThemeContext = createContext<ThemeContextValue | null>(null);

function getSystemTheme(): 'light' | 'dark' {
  if (typeof window === 'undefined') return 'light';
  return window.matchMedia?.('(prefers-color-scheme: dark)').matches ? 'dark' : 'light';
}

export function ThemeProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearanceState] = useState<UiAppearance>(readCache);
  const [systemTheme, setSystemTheme] = useState<'light' | 'dark'>(getSystemTheme);
  const [ready, setReady] = useState(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  // Mirror of the latest appearance so the (pure) setAppearance can read the
  // current value without an impure state-updater closure (StrictMode-safe).
  // Synced via a layout effect (not during render) + written synchronously by
  // the mutators themselves so consecutive calls in one tick still compose.
  const appearanceRef = useRef(appearance);

  const resolved: 'light' | 'dark' = appearance.mode === 'system' ? systemTheme : appearance.mode;

  // Track the OS theme for `mode: 'system'`.
  useEffect(() => {
    const mq = window.matchMedia('(prefers-color-scheme: dark)');
    const handler = (e: MediaQueryListEvent) => setSystemTheme(e.matches ? 'dark' : 'light');
    mq.addEventListener('change', handler);
    return () => mq.removeEventListener('change', handler);
  }, []);

  // Initial server load (+ one-time legacy migration). Runs once.
  useEffect(() => {
    let cancelled = false;
    (async () => {
      const server = await fetchAppearance();
      if (cancelled) return;
      let next = server ?? readCache();

      if (!localStorage.getItem(LS_MIGRATED)) {
        try { localStorage.setItem(LS_MIGRATED, '1'); } catch { /* ignore */ }
        const legacy = readLegacyOverlay();
        // Only migrate when the server has never been customized, so we don't
        // clobber a look already set from another device.
        if (legacy && server && isPristine(server)) {
          next = { ...server, ...legacy, background: server.background };
          void persistAppearance(next);
        }
      }

      setAppearanceState(next);
      writeCache(next);
      setReady(true);
    })();
    return () => { cancelled = true; };
  }, []);

  // Keep the mutator-facing ref in sync after any state change (init load,
  // system-theme flip, upload/delete). Written in an effect, never during render.
  useLayoutEffect(() => { appearanceRef.current = appearance; }, [appearance]);

  // Apply to the DOM before paint (useLayoutEffect) so the post-mount
  // application doesn't flash. The pre-mount flash is handled by the inline
  // bootstrap script in index.html.
  useLayoutEffect(() => { applyAppearance(appearance, resolved); }, [appearance, resolved]);
  useLayoutEffect(() => { applyBackgroundLayer(appearance); }, [appearance]);

  // Flush a pending debounced save on unmount (defensive — the provider lives
  // at the app root and normally never unmounts).
  useEffect(() => () => { if (saveTimer.current) clearTimeout(saveTimer.current); }, []);

  const setAppearance = useCallback((patch: AppearancePatch) => {
    const prev = appearanceRef.current;
    const next: UiAppearance = {
      ...prev,
      ...patch,
      background: patch.background ? { ...prev.background, ...patch.background } : prev.background,
    };
    appearanceRef.current = next;
    setAppearanceState(next);
    writeCache(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => void persistAppearance(next), 400);
  }, []);

  const uploadBackground = useMemo(() => async (file: File) => {
    const token = authToken();
    if (!token) throw new Error('未登录');
    const form = new FormData();
    form.append('file', file);
    const res = await fetch('/api/ui/background', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: form });
    if (!res.ok) {
      const e = (await res.json().catch(() => ({}))) as { message?: string };
      throw new Error(e.message || '上传失败');
    }
    const data = (await res.json()) as { config?: { appearance?: UiAppearance } };
    const ap = data.config?.appearance;
    if (ap) { appearanceRef.current = ap; setAppearanceState(ap); writeCache(ap); }
  }, []);

  const removeBackground = useMemo(() => async () => {
    const token = authToken();
    if (!token) throw new Error('未登录');
    const res = await fetch('/api/ui/background', { method: 'DELETE', headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('删除失败');
    const data = (await res.json()) as { config?: { appearance?: UiAppearance } };
    const ap = data.config?.appearance;
    if (ap) { appearanceRef.current = ap; setAppearanceState(ap); writeCache(ap); }
  }, []);

  const formatClock = useMemo(() => (input: string | number | Date) => {
    const d = input instanceof Date ? input : new Date(input);
    if (Number.isNaN(d.getTime())) return String(input);
    return d.toLocaleTimeString(undefined, {
      hour12: appearance.timeFormat === '12h',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
  }, [appearance.timeFormat]);

  const value = useMemo<ThemeContextValue>(() => ({
    appearance,
    ready,
    resolved,
    setAppearance,
    uploadBackground,
    removeBackground,
    formatClock,
    mode: appearance.mode,
    setMode: (m: ThemeMode) => setAppearance({ mode: m }),
    pollInterval: appearance.pollInterval,
  }), [appearance, ready, resolved, setAppearance, uploadBackground, removeBackground, formatClock]);

  return (
    <ThemeContext.Provider value={value}>
      <MotionConfig reducedMotion={appearance.reduceMotion ? 'always' : 'user'}>
        {children}
      </MotionConfig>
    </ThemeContext.Provider>
  );
}

export function useTheme(): ThemeContextValue {
  const ctx = useContext(ThemeContext);
  if (!ctx) throw new Error('useTheme must be used within ThemeProvider');
  return ctx;
}
