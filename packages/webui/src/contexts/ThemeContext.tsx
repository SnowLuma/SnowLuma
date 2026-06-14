import { createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { flushSync } from 'react-dom';
import { MotionConfig } from 'motion/react';
import type { Palette, ThemeMode, UiAppearance, UiBackground } from '@/types';

// Re-export the appearance value types so consumers (settings page etc.) can
// import them straight from the context module.
export type {
  AccentMode, AccentScope, BackgroundType, DarkIntensity, Density, Palette, SidebarStyle, ThemeMode, TimeFormat, UiAppearance,
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
  palette: 'default',
  sidebarStyle: 'follow',
  background: { type: 'none', color: '#0ea5e9', gradient: 'none', imageOpacity: 0.15, imageBlur: 0, hasImage: false, imageMime: '', imageVersion: 0 },
  fontSans: 'default',
  fontMono: 'default',
  uiScale: 1,
  radius: 0.75,
  density: 'cozy',
  reduceMotion: false,
  disableMotion: false,
  highContrast: false,
  sidebarDefaultCollapsed: false,
  timeFormat: '24h',
  pollInterval: 3000,
  customCss: '',
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

// Selected-state surface tints derived from the accent, so the sidebar's
// active item (--sidebar-accent) and the settings rail's active row (--accent)
// follow the chosen accent — not just primary/ring. Default palette only; the
// Catppuccin/Rosé Pine/… palettes own their own --accent/--sidebar-accent.
function accentSurfaces(hex: string, global: boolean, mode: 'light' | 'dark'): string {
  const bgMix = mode === 'light' ? 16 : 26; // accent over the canvas → --accent
  const sbMix = mode === 'light' ? 18 : 28; // accent over the sidebar → --sidebar-accent
  const fgMix = 72; // accent-forward text legible on those tints
  const sidebar =
    `--sidebar-accent:color-mix(in oklab, ${hex} ${sbMix}%, var(--sidebar));` +
    `--sidebar-accent-foreground:color-mix(in oklab, ${hex} ${fgMix}%, var(--foreground));`;
  if (!global) return sidebar;
  return (
    `--accent:color-mix(in oklab, ${hex} ${bgMix}%, var(--background));` +
    `--accent-foreground:color-mix(in oklab, ${hex} ${fgMix}%, var(--foreground));` +
    sidebar
  );
}

function accentVarsCss(a: UiAppearance): string {
  const global = a.accentScope === 'global';
  // Only the default palette gets accent-tinted surfaces (others own theirs).
  const surf = a.palette === 'default';
  if (a.accentMode === 'custom') {
    const hex = safeHex(a.accentCustom, '#38bdf8');
    const lightFg = readableForeground(hex);
    // Dark mode: lighten the accent for contrast on dark surfaces, and pick
    // the foreground from the *lightened* colour (a light accent needs dark text).
    const darkHex = lightenHex(hex, 0.18);
    const darkFg = readableForeground(darkHex);
    const lightCore = global
      ? `--primary:${hex};--primary-foreground:${lightFg};--ring:${hex};--sidebar-primary:${hex};--sidebar-primary-foreground:${lightFg};--sidebar-ring:${hex};`
      : `--sidebar-primary:${hex};--sidebar-primary-foreground:${lightFg};--sidebar-ring:${hex};`;
    const darkCore = global
      ? `--primary:${darkHex};--primary-foreground:${darkFg};--ring:${darkHex};--sidebar-primary:${darkHex};--sidebar-primary-foreground:${darkFg};--sidebar-ring:${darkHex};`
      : `--sidebar-primary:${darkHex};--sidebar-primary-foreground:${darkFg};--sidebar-ring:${darkHex};`;
    const lightBlock = lightCore + (surf ? accentSurfaces(hex, global, 'light') : '');
    const darkBlock = darkCore + (surf ? accentSurfaces(darkHex, global, 'dark') : '');
    return `:root{${lightBlock}}\n.dark{${darkBlock}}`;
  }
  const spec = ACCENTS.find((x) => x.id === a.accentPreset) ?? ACCENTS[0];
  const lightCore = global
    ? `--primary:${spec.light.primary};--ring:${spec.light.ring};--sidebar-primary:${spec.light.primary};--sidebar-ring:${spec.light.ring};`
    : `--sidebar-primary:${spec.light.primary};--sidebar-ring:${spec.light.ring};`;
  const darkCore = global
    ? `--primary:${spec.dark.primary};--ring:${spec.dark.ring};--sidebar-primary:${spec.dark.primary};--sidebar-ring:${spec.dark.ring};`
    : `--sidebar-primary:${spec.dark.primary};--sidebar-ring:${spec.dark.ring};`;
  // Presets keep the base token's primary-foreground (designed for these hues).
  const light = lightCore + (surf ? accentSurfaces(spec.light.primary, global, 'light') : '');
  const dark = darkCore + (surf ? accentSurfaces(spec.dark.primary, global, 'dark') : '');
  return `:root{${light}}\n.dark{${dark}}`;
}

// ─── Full color-scheme palettes (surface/base token sets) ──────────────────
// Soft, complete palettes (Catppuccin, Rosé Pine, Nord, Everforest) mapped onto
// our token names. Accent (--primary/--ring) is intentionally left to the accent
// system so the two compose. Applied via the injected theme stylesheet over the
// base :root/.dark (see applyAppearance); darkIntensity is forced off for these
// (their darkness is part of the palette).
type PaletteVars = Record<string, string>;

interface PaletteInput {
  bg: string; fg: string; card: string;
  muted: string; mutedFg: string; accent: string; border: string;
  sidebar: string; sidebarAccent: string;
  destructive: string; destructiveFg: string; success: string; warning: string;
}

// Expand a palette's semantic colors into the full token set (all *-foreground
// surfaces share the palette text; popover=card, input/sidebar-border=border).
function pal(c: PaletteInput): PaletteVars {
  return {
    '--background': c.bg, '--foreground': c.fg,
    '--card': c.card, '--card-foreground': c.fg,
    '--popover': c.card, '--popover-foreground': c.fg,
    '--secondary': c.muted, '--secondary-foreground': c.fg,
    '--muted': c.muted, '--muted-foreground': c.mutedFg,
    '--accent': c.accent, '--accent-foreground': c.fg,
    '--destructive': c.destructive, '--destructive-foreground': c.destructiveFg,
    '--success': c.success, '--warning': c.warning,
    '--border': c.border, '--input': c.border,
    '--sidebar': c.sidebar, '--sidebar-foreground': c.fg,
    '--sidebar-accent': c.sidebarAccent, '--sidebar-accent-foreground': c.fg, '--sidebar-border': c.border,
  };
}

/** Light-flavored palettes; every other non-default palette is dark. */
const LIGHT_PALETTES = new Set<Palette>(['catppuccin-latte', 'rose-pine-dawn', 'everforest-light']);

const PALETTES: Record<Exclude<Palette, 'default'>, PaletteVars> = {
  'catppuccin-latte': pal({ bg: '#eff1f5', fg: '#4c4f69', card: '#ffffff', muted: '#e6e9ef', mutedFg: '#6c6f85', accent: '#dce0e8', border: '#ccd0da', sidebar: '#e6e9ef', sidebarAccent: '#dce0e8', destructive: '#d20f39', destructiveFg: '#ffffff', success: '#40a02b', warning: '#df8e1d' }),
  'catppuccin-frappe': pal({ bg: '#303446', fg: '#c6d0f5', card: '#414559', muted: '#414559', mutedFg: '#a5adce', accent: '#51576d', border: '#51576d', sidebar: '#292c3c', sidebarAccent: '#414559', destructive: '#e78284', destructiveFg: '#232634', success: '#a6d189', warning: '#e5c890' }),
  'catppuccin-macchiato': pal({ bg: '#24273a', fg: '#cad3f5', card: '#363a4f', muted: '#363a4f', mutedFg: '#a5adcb', accent: '#494d64', border: '#494d64', sidebar: '#1e2030', sidebarAccent: '#363a4f', destructive: '#ed8796', destructiveFg: '#181926', success: '#a6da95', warning: '#eed49f' }),
  'catppuccin-mocha': pal({ bg: '#1e1e2e', fg: '#cdd6f4', card: '#313244', muted: '#313244', mutedFg: '#a6adc8', accent: '#45475a', border: '#45475a', sidebar: '#181825', sidebarAccent: '#313244', destructive: '#f38ba8', destructiveFg: '#11111b', success: '#a6e3a1', warning: '#f9e2af' }),
  // Rosé Pine — soft rosy/iris dark, plus the lighter Moon and the light Dawn.
  'rose-pine': pal({ bg: '#191724', fg: '#e0def4', card: '#1f1d2e', muted: '#26233a', mutedFg: '#908caa', accent: '#403d52', border: '#403d52', sidebar: '#1f1d2e', sidebarAccent: '#26233a', destructive: '#eb6f92', destructiveFg: '#191724', success: '#9ccfd8', warning: '#f6c177' }),
  'rose-pine-moon': pal({ bg: '#232136', fg: '#e0def4', card: '#2a273f', muted: '#393552', mutedFg: '#908caa', accent: '#44415a', border: '#44415a', sidebar: '#2a273f', sidebarAccent: '#393552', destructive: '#eb6f92', destructiveFg: '#232136', success: '#9ccfd8', warning: '#f6c177' }),
  'rose-pine-dawn': pal({ bg: '#faf4ed', fg: '#575279', card: '#fffaf3', muted: '#f2e9e1', mutedFg: '#797593', accent: '#dfdad9', border: '#dfdad9', sidebar: '#f2e9e1', sidebarAccent: '#dfdad9', destructive: '#b4637a', destructiveFg: '#faf4ed', success: '#286983', warning: '#ea9d34' }),
  // Nord — cool arctic dark.
  'nord': pal({ bg: '#2e3440', fg: '#e5e9f0', card: '#3b4252', muted: '#3b4252', mutedFg: '#9aa1b2', accent: '#434c5e', border: '#434c5e', sidebar: '#2b303b', sidebarAccent: '#434c5e', destructive: '#bf616a', destructiveFg: '#eceff4', success: '#a3be8c', warning: '#ebcb8b' }),
  // Everforest — soft warm green, dark + light.
  'everforest-dark': pal({ bg: '#2d353b', fg: '#d3c6aa', card: '#343f44', muted: '#343f44', mutedFg: '#9da9a0', accent: '#3d484d', border: '#475258', sidebar: '#232a2e', sidebarAccent: '#3d484d', destructive: '#e67e80', destructiveFg: '#2d353b', success: '#a7c080', warning: '#dbbc7f' }),
  'everforest-light': pal({ bg: '#efebd4', fg: '#5c6a72', card: '#fdf6e3', muted: '#e6e2cc', mutedFg: '#829181', accent: '#e0dcc7', border: '#e0dcc7', sidebar: '#f4f0d9', sidebarAccent: '#e6e2cc', destructive: '#f85552', destructiveFg: '#fdf6e3', success: '#8da101', warning: '#dfa000' }),
};

/** A palette fixes light/dark; 'default' defers to mode. */
export function paletteResolved(p: Palette): 'light' | 'dark' | null {
  if (p === 'default') return null;
  return LIGHT_PALETTES.has(p) ? 'light' : 'dark';
}

export interface PaletteSpec {
  id: Palette;
  label: string;
  /** Picker preview: surface tile + three signature accent dots. */
  preview: { bg: string; surface: string; dots: [string, string, string] };
}

export const PALETTE_OPTIONS: PaletteSpec[] = [
  { id: 'default', label: '默认', preview: { bg: '#f1f5f9', surface: '#ffffff', dots: ['#0ea5e9', '#10b981', '#f43f5e'] } },
  { id: 'catppuccin-latte', label: 'Latte', preview: { bg: '#eff1f5', surface: '#ffffff', dots: ['#8839ef', '#40a02b', '#d20f39'] } },
  { id: 'catppuccin-frappe', label: 'Frappé', preview: { bg: '#303446', surface: '#414559', dots: ['#ca9ee6', '#a6d189', '#e78284'] } },
  { id: 'catppuccin-macchiato', label: 'Macchiato', preview: { bg: '#24273a', surface: '#363a4f', dots: ['#c6a0f6', '#a6da95', '#ed8796'] } },
  { id: 'catppuccin-mocha', label: 'Mocha', preview: { bg: '#1e1e2e', surface: '#313244', dots: ['#cba6f7', '#a6e3a1', '#f38ba8'] } },
  { id: 'rose-pine', label: 'Rosé Pine', preview: { bg: '#191724', surface: '#1f1d2e', dots: ['#c4a7e7', '#9ccfd8', '#eb6f92'] } },
  { id: 'rose-pine-moon', label: 'Rosé Pine Moon', preview: { bg: '#232136', surface: '#2a273f', dots: ['#c4a7e7', '#9ccfd8', '#eb6f92'] } },
  { id: 'rose-pine-dawn', label: 'Rosé Pine Dawn', preview: { bg: '#faf4ed', surface: '#fffaf3', dots: ['#907aa9', '#286983', '#b4637a'] } },
  { id: 'nord', label: 'Nord', preview: { bg: '#2e3440', surface: '#3b4252', dots: ['#81a1c1', '#a3be8c', '#bf616a'] } },
  { id: 'everforest-dark', label: 'Everforest 暗', preview: { bg: '#2d353b', surface: '#343f44', dots: ['#a7c080', '#7fbbb3', '#e67e80'] } },
  { id: 'everforest-light', label: 'Everforest 亮', preview: { bg: '#efebd4', surface: '#fdf6e3', dots: ['#8da101', '#3a94c5', '#f85552'] } },
];

function paletteVarsCss(a: UiAppearance): string {
  if (a.palette === 'default') return '';
  const vars = PALETTES[a.palette];
  if (!vars) return '';
  const body = Object.entries(vars).map(([k, v]) => `${k}:${v};`).join('');
  // Light palette → :root; dark → .dark (resolved is forced to match in the
  // provider, so the selector always matches the active scheme).
  const selector = LIGHT_PALETTES.has(a.palette) ? ':root' : '.dark';
  return `${selector}{${body}}`;
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
  // A Catppuccin flavor owns its own darkness, so the OLED "black" override
  // must not fight it — force a neutral intensity (it has no CSS rule) so the
  // injected palette wins over base .dark.
  root.setAttribute('data-dark-intensity', a.palette === 'default' ? a.darkIntensity : 'soft');
  root.setAttribute('data-palette', a.palette);
  root.setAttribute('data-sidebar-style', a.sidebarStyle);
  root.setAttribute('data-contrast', a.highContrast ? 'high' : 'normal');
  // 减弱动效 OR 关闭全部动效 both engage the reduce-motion CSS/Framer layer;
  // 关闭全部动效 additionally sets data-no-motion (kills CSS animations outright
  // and gates Framer entrance fades that reduce-motion leaves on).
  root.setAttribute('data-reduce-motion', (a.reduceMotion || a.disableMotion) ? '1' : '0');
  root.setAttribute('data-no-motion', a.disableMotion ? '1' : '0');

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
  // Palette (base/surface tokens) first, then accent (--primary/--ring) — a
  // disjoint var set, layered after so it composes with any flavor.
  el.textContent = `${paletteVarsCss(a)}\n${accentVarsCss(a)}`;

  // Custom CSS — appended AFTER the accent block so it is the last style in
  // <head> and can override anything. Skipped under ?safe-mode=1 (escape
  // hatch) so a broken rule can't lock the operator out of fixing it.
  const cssId = 'snowluma-custom-css';
  let cssEl = document.getElementById(cssId) as HTMLStyleElement | null;
  // Apply custom CSS ONLY when authed — the cache (snowluma_ui_appearance)
  // may hold customCss from a prior session, and applyAppearance runs at boot
  // before auth; without this gate that cached CSS would hit the login page
  // (bypassing the server-side strip) and could lock the operator out.
  const css = (isSafeMode() || !authToken()) ? '' : (a.customCss || '');
  if (css) {
    if (!cssEl) {
      cssEl = document.createElement('style');
      cssEl.id = cssId;
      document.head.appendChild(cssEl);
    }
    if (cssEl.textContent !== css) cssEl.textContent = css;
  } else if (cssEl) {
    cssEl.textContent = '';
  }
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
  const token = authToken();
  try {
    // Authed: fetch the full config so we get `customCss` (which the public
    // subset strips). Pre-auth (login page): the cosmetic public subset only.
    if (token) {
      const res = await fetch('/api/ui', { headers: { Authorization: `Bearer ${token}` } });
      if (res.ok) {
        const data = (await res.json()) as { config?: { appearance?: UiAppearance } };
        if (data.config?.appearance) return data.config.appearance;
      }
      // 401/expired → fall through to the public subset.
    }
    const res = await fetch('/api/ui/public');
    if (!res.ok) return null;
    const data = (await res.json()) as { appearance?: UiAppearance };
    return data.appearance ?? null;
  } catch {
    return null;
  }
}

/** `?safe-mode=1` disables custom CSS so a broken rule can't lock the operator
 *  out. Sticky for the session (sessionStorage) so it survives in-app
 *  navigation — and so editing the CSS to fix it doesn't re-inject the broken
 *  rule mid-fix. Clears when the tab/session closes. */
function isSafeMode(): boolean {
  try {
    if (new URLSearchParams(window.location.search).get('safe-mode') === '1') {
      sessionStorage.setItem('snowluma_safe_mode', '1');
      return true;
    }
    return sessionStorage.getItem('snowluma_safe_mode') === '1';
  } catch {
    return false;
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

// ─── Light/dark reveal (View Transitions API) ──────────────────────────────
// Where the user last clicked, so the theme reveal emanates from there.
let lastPointer: { x: number; y: number } | null = null;

/** Run `apply` (a synchronous state commit) inside a circular light/dark
 *  reveal centered on the last click. flushSync forces the DOM to update inside
 *  the transition callback so the "after" snapshot is captured. Falls back to
 *  an instant apply where View Transitions aren't supported (e.g. Firefox). */
function runThemeReveal(apply: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (typeof doc.startViewTransition !== 'function') { apply(); return; }
  const root = document.documentElement;
  const x = lastPointer?.x ?? window.innerWidth / 2;
  const y = lastPointer?.y ?? window.innerHeight / 2;
  const r = Math.hypot(Math.max(x, window.innerWidth - x), Math.max(y, window.innerHeight - y));
  root.style.setProperty('--vt-x', `${x}px`);
  root.style.setProperty('--vt-y', `${y}px`);
  root.style.setProperty('--vt-r', `${r}px`);
  doc.startViewTransition(() => flushSync(apply));
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
  /** Re-fetch appearance from the server (e.g. after login, so the authed
   *  `customCss` loads). */
  reloadAppearance: () => Promise<void>;
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

  // A Catppuccin flavor fixes light/dark; otherwise honor mode (+ system).
  const resolved: 'light' | 'dark' =
    paletteResolved(appearance.palette) ?? (appearance.mode === 'system' ? systemTheme : appearance.mode);

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

  // Track the last click so the light/dark reveal can emanate from it.
  useEffect(() => {
    const onDown = (e: PointerEvent) => { lastPointer = { x: e.clientX, y: e.clientY }; };
    window.addEventListener('pointerdown', onDown, { capture: true });
    return () => window.removeEventListener('pointerdown', onDown, { capture: true });
  }, []);

  const commit = useCallback((patch: AppearancePatch) => {
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

  const setAppearance = useCallback((patch: AppearancePatch) => {
    const prev = appearanceRef.current;
    // Animate a circular light/dark reveal only for brightness/scheme changes
    // (mode, palette, dark intensity) — and never when motion is reduced/off.
    const schemeChange =
      (patch.mode !== undefined && patch.mode !== prev.mode) ||
      (patch.palette !== undefined && patch.palette !== prev.palette) ||
      (patch.darkIntensity !== undefined && patch.darkIntensity !== prev.darkIntensity);
    if (schemeChange && !prev.reduceMotion && !prev.disableMotion) {
      runThemeReveal(() => commit(patch));
    } else {
      commit(patch);
    }
  }, [commit]);

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

  const reloadAppearance = useCallback(async () => {
    // Post-auth, the only field the pre-auth public subset lacked is
    // `customCss`. Merge JUST that (via setAppearance, which preserves every
    // other field — incl. a pre-auth localStorage migration — and write-through
    // persists). A full overwrite here would clobber that migration with the
    // server's not-yet-persisted default.
    const server = await fetchAppearance();
    if (server && server.customCss !== appearanceRef.current.customCss) {
      setAppearance({ customCss: server.customCss });
    }
  }, [setAppearance]);

  const value = useMemo<ThemeContextValue>(() => ({
    appearance,
    ready,
    resolved,
    setAppearance,
    uploadBackground,
    removeBackground,
    formatClock,
    reloadAppearance,
    mode: appearance.mode,
    setMode: (m: ThemeMode) => setAppearance({ mode: m }),
    pollInterval: appearance.pollInterval,
  }), [appearance, ready, resolved, setAppearance, uploadBackground, removeBackground, formatClock, reloadAppearance]);

  return (
    <ThemeContext.Provider value={value}>
      <MotionConfig reducedMotion={(appearance.reduceMotion || appearance.disableMotion) ? 'always' : 'user'}>
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
