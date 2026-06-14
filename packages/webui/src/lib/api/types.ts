import type {
  AccountConnections,
  HookProcessInfo,
  LogEntry,
  LogLevel,
  OneBotConfig,
  QQInfo,
  SystemInfo,
  UiAppearance,
  UiConfig,
  UpdateInfo,
} from '@/types';
import type { PasswordRule } from '@/components/pages/change-password-page';

export class ApiError extends Error {
  status: number;
  code: string | undefined;
  constructor(status: number, message: string, code?: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
    this.code = code;
  }
}

export type LoginResult =
  | { ok: true; mustChangePassword: boolean }
  | { ok: false; message: string };

export type ChangePasswordResult = { success: boolean; message?: string };

export type ProcessActionResult = {
  process?: HookProcessInfo & { error?: string };
};

export type StreamStatus = 'open' | 'reconnecting' | 'closed';

export interface LogsStreamOptions {
  onLine: (line: LogEntry) => void;
  onStatus?: (status: StreamStatus) => void;
}

export interface ApiClient {
  // ---- auth ----
  login(password: string): Promise<LoginResult>;
  logout(): Promise<void>;
  /** True if the current token is still valid. */
  status(): Promise<boolean>;
  /** Whether the current session must rotate its password before doing anything else. */
  mustChangePassword(): Promise<boolean>;
  checkPasswordStrength(password: string): Promise<{ rules: PasswordRule[]; valid: boolean }>;
  changePassword(oldPassword: string, newPassword: string): Promise<ChangePasswordResult>;

  // ---- system ----
  qqList(): Promise<QQInfo[]>;
  system(): Promise<SystemInfo>;
  /** Live OneBot adapter health per account. */
  connections(): Promise<AccountConnections[]>;

  // ---- hook processes ----
  processes: {
    list(): Promise<HookProcessInfo[]>;
    load(pid: number): Promise<ProcessActionResult>;
    unload(pid: number): Promise<ProcessActionResult>;
    refresh(pid: number): Promise<ProcessActionResult>;
    probeLoginInfo(pid: number): Promise<unknown>;
  };

  // ---- OneBotInstance per-UIN config ----
  config: {
    get(uin: string): Promise<OneBotConfig>;
    save(uin: string, config: OneBotConfig): Promise<OneBotConfig>;
  };

  // ---- update check ----
  update: {
    /** Advisory check for a newer stable release. Read-only — never downloads. */
    check(force?: boolean): Promise<UpdateInfo>;
  };

  // ---- WebUI customization (config/ui.json) ----
  ui: {
    /** Full config (appearance + layout). Bearer-gated. */
    get(): Promise<UiConfig>;
    /** Persist config. Section-level merge: a payload with only `appearance`
     *  or only `layout` keeps the other section. Returns the normalized view. */
    save(config: Partial<UiConfig>): Promise<UiConfig>;
    /** Cosmetic appearance subset, usable pre-auth (login page theming). */
    getPublic(): Promise<UiAppearance>;
    /** Upload a background image (PNG/JPEG/WebP, ≤5MB). Returns updated config. */
    uploadBackground(file: File): Promise<UiConfig>;
    /** Remove the background image. Returns updated config. */
    deleteBackground(): Promise<UiConfig>;
  };

  // ---- logs ----
  logs: {
    list(limit?: number): Promise<LogEntry[]>;
    /** Subscribe to the SSE log stream. Returns a disposer. */
    stream(options: LogsStreamOptions): () => void;
    /** Current console / subscriber level. File output is always debug. */
    getLevel(): Promise<{ level: LogLevel; levels: LogLevel[] }>;
    /** Change the console / subscriber level at runtime. No restart needed. */
    setLevel(level: LogLevel): Promise<{ level: LogLevel; levels: LogLevel[] }>;
  };

  /** Escape hatch for endpoints not yet wrapped above. */
  request(url: string, init?: RequestInit): Promise<Response>;
}

export interface TokenStore {
  load(): string | null;
  save(token: string | null): void;
}

export interface CreateApiClientOptions {
  /** Persists the bearer token across reloads. Defaults to localStorage('snowluma_token'). */
  tokenStore?: TokenStore;
  /** Fires whenever a request returns 401, after the token has been cleared. */
  onUnauthorized?: () => void;
}
