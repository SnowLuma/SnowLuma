export const APP_NAME = 'SnowLuma';
// Injected at build time by Vite from the monorepo root package.json.
export const APP_VERSION = __APP_VERSION__;

/** Advisory update-availability info from `GET /api/update/check`. */
export interface UpdateInfo {
  /** The running build's version (no `v` prefix). */
  current: string;
  /** Latest stable release version, or null if the check did not complete. */
  latest: string | null;
  /** True only when `latest` is strictly newer than `current`. */
  hasUpdate: boolean;
  /** GitHub release page URL for the latest release. */
  htmlUrl: string | null;
  /** Release notes (markdown), truncated server-side. */
  notes: string | null;
  /** ISO timestamp the latest release was published. */
  publishedAt: string | null;
  /** When this result was produced (epoch ms). */
  checkedAt: number;
  /** Set when the check was skipped/disabled or failed; the UI degrades quietly. */
  error?: string;
}

export interface QQInfo {
  uin: string;
  nickname: string;
}

export type AdapterStatusLevel = 'ok' | 'warn' | 'down' | 'disabled';

export interface AdapterStatus {
  name: string;
  kind: 'httpServer' | 'httpClient' | 'wsServer' | 'wsClient';
  status: AdapterStatusLevel;
  detail: string;
}

export interface AccountConnections {
  uin: string;
  nickname: string;
  adapters: AdapterStatus[];
}

export interface HookProcessInfo {
  pid: number;
  name: string;
  path: string;
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin: string;
  status: 'available' | 'loading' | 'connecting' | 'loaded' | 'online' | 'error' | 'disconnected';
  error: string;
  method: string;
}

export type MessageFormat = 'array' | 'string';
export type WsRole = 'Api' | 'Event' | 'Universal';

interface NetworkBase {
  name: string;
  enabled?: boolean;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

export interface HttpServerNetwork extends NetworkBase {
  host?: string;
  port: number;
  path?: string;
}

export interface HttpClientNetwork extends NetworkBase {
  url: string;
  timeoutMs?: number;
}

export interface WsServerNetwork extends NetworkBase {
  host?: string;
  port: number;
  path?: string;
  role?: WsRole;
}

export interface WsClientNetwork extends NetworkBase {
  url: string;
  role?: WsRole;
  reconnectIntervalMs?: number;
}

export interface OneBotNetworks {
  httpServers: HttpServerNetwork[];
  httpClients: HttpClientNetwork[];
  wsServers: WsServerNetwork[];
  wsClients: WsClientNetwork[];
}

/** Built-in `#sl` status command settings (trigger word is hardcoded). */
export interface StatusCommandConfig {
  enabled: boolean;
  swallow: boolean;
  cooldownSeconds: number;
}

export interface OneBotConfig {
  networks: OneBotNetworks;
  musicSignUrl?: string;
  statusCommand: StatusCommandConfig;
}

export type NetworkKind = keyof OneBotNetworks;

export interface SystemInfo {
  hostname: string;
  platform: string;
  arch: string;
  release: string;
  uptime: number;
  processUptime: number;
  nodeVersion: string;
  cpu: {
    model: string;
    cores: number;
    speedMHz: number;
    loadAvg: number[];
    perCore: number[];
    average: number;
  };
  memory: {
    total: number;
    free: number;
    used: number;
    usagePercent: number;
  };
  runtime: {
    pid: number;
    rss: number;
    heapTotal: number;
    heapUsed: number;
    external: number;
    arrayBuffers: number;
  };
}

export type LogLevel = 'trace' | 'debug' | 'info' | 'success' | 'warn' | 'error';

export interface LogEntry {
  id: number;
  time: string;
  level: LogLevel;
  /** QQ uin, when the source logger was derived via `.child({ uin })`. */
  uin?: number;
  /** Request correlation id, when emitted inside a request scope. */
  req?: number;
  scope: string;
  message: string;
  line: string;
}

// ─── WebUI customization config (config/ui.json) ───────────────────────────
// Mirror of the server schema in core/src/webui/ui-config.ts. The contract is
// the JSON shape served by `/api/ui`; this is the client-side view of it.

export type ThemeMode = 'light' | 'dark' | 'system';
export type AccentMode = 'preset' | 'custom';
export type AccentScope = 'sidebar' | 'global';
export type DarkIntensity = 'soft' | 'black';
export type SidebarStyle = 'follow' | 'panel' | 'accent';
export type BackgroundType = 'none' | 'solid' | 'gradient' | 'image';
export type Density = 'cozy' | 'compact';
export type TimeFormat = '12h' | '24h';
export type Palette =
  | 'default'
  | 'catppuccin-latte' | 'catppuccin-frappe' | 'catppuccin-macchiato' | 'catppuccin-mocha'
  | 'rose-pine' | 'rose-pine-moon' | 'rose-pine-dawn'
  | 'nord'
  | 'everforest-dark' | 'everforest-light';

export interface UiBackground {
  type: BackgroundType;
  color: string;
  gradient: string;
  imageOpacity: number;
  imageBlur: number;
  /** Server-managed: true when an image is on disk. Read-only to the client. */
  hasImage: boolean;
  imageMime: string;
  /** Server-managed cache-bust counter, bumped on each upload. */
  imageVersion: number;
}

export interface UiAppearance {
  mode: ThemeMode;
  accentMode: AccentMode;
  accentPreset: string;
  accentCustom: string;
  accentScope: AccentScope;
  darkIntensity: DarkIntensity;
  palette: Palette;
  sidebarStyle: SidebarStyle;
  background: UiBackground;
  fontSans: string;
  fontMono: string;
  uiScale: number;
  radius: number;
  density: Density;
  reduceMotion: boolean;
  disableMotion: boolean;
  highContrast: boolean;
  sidebarDefaultCollapsed: boolean;
  timeFormat: TimeFormat;
  pollInterval: number;
  /** Operator custom CSS (applied post-auth only; stripped from /api/ui/public). */
  customCss: string;
}

export interface UiLayoutItem {
  id: string;
  visible: boolean;
  /** Grid position/size — overview blocks only; nav items omit them. */
  x?: number;
  y?: number;
  w?: number;
  h?: number;
  /** Per-widget settings; interpreted client-side by widget type. */
  config?: Record<string, unknown>;
}

export interface UiLayout {
  overviewBlocks: UiLayoutItem[];
  navItems: UiLayoutItem[];
}

export interface UiHighlightRule {
  keyword: string;
  color: string;
}

export interface UiLogsPrefs {
  visibleLevels: string[];
  maxLines: number;
  autoScroll: boolean;
  wrap: boolean;
  highlightRules: UiHighlightRule[];
}

export interface UiPages {
  defaultRoute: string;
  logs: UiLogsPrefs;
  processesSort: string;
  configTab: string;
}

export interface UiConfig {
  version: number;
  appearance: UiAppearance;
  layout: UiLayout;
  pages: UiPages;
}
