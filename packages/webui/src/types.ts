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
