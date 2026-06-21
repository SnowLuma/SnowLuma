import type {
  AccountConnections,
  BackupBundle,
  BackupImportResult,
  DebugActionDoc,
  DebugInvokeResult,
  DebugStreamMessage,
  HookProcessInfo,
  LogEntry,
  LogLevel,
  NotificationDeliveryRecord,
  NotificationsConfig,
  OneBotConfig,
  QQInfo,
  SystemInfo,
  SystemSettings,
  SystemSettingsPatch,
  SystemSettingsResponse,
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

export interface AgreementDoc {
  id: 'eula' | 'privacy';
  title: string;
  declaredVersion: string;
  effectiveDate: string;
  text: string;
}

export interface AgreementsPayload {
  /** Content-hash version of the current agreement set. */
  version: string;
  /** Whether the operator must (re-)accept before using the panel. */
  consentRequired: boolean;
  documents: AgreementDoc[];
}

export type RecordConsentResult = {
  success: boolean;
  message?: string;
  /** On a 409 version-mismatch, the server's current version to re-fetch. */
  currentVersion?: string;
};

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

  // ---- EULA / PRIVACY consent (shown after login, before set-password) ----
  agreements: {
    /** Fetch agreement texts + current version + whether consent is required. */
    get(): Promise<AgreementsPayload>;
    /** Record acceptance of `version`. success:false (409) carries currentVersion. */
    recordConsent(version: string): Promise<RecordConsentResult>;
  };

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

  // ---- WebUI listener self-config (port / host / TLS / trust-proxy) ----
  systemSettings: {
    get(): Promise<SystemSettingsResponse>;
    save(patch: SystemSettingsPatch): Promise<{ settings: SystemSettings; restartRequiredToApply: boolean }>;
    /** Validate + write config/cert.pem + key.pem (restart to apply). */
    uploadCert(cert: string, key: string): Promise<void>;
    deleteCert(): Promise<void>;
    /** Download the config backup bundle (credentials gated). */
    exportBackup(includeCredentials: boolean): Promise<BackupBundle>;
    /** Validate + restore a bundle (snapshots current config first). */
    importBackup(backup: BackupBundle, restoreCredentials: boolean): Promise<BackupImportResult>;
  };

  // ---- debug tools (action tester + live event/action stream) ----
  debug: {
    actions(): Promise<{ actions: DebugActionDoc[]; categories: { category: string; count: number }[] }>;
    invoke(uin: string, action: string, params: Record<string, unknown>): Promise<DebugInvokeResult>;
    /** Live merged SSE; returns an unsubscribe. */
    stream(onMessage: (m: DebugStreamMessage) => void, onStatus?: (s: StreamStatus) => void): () => void;
  };

  // ---- notifications (account up/down webhooks) ----
  notifications: {
    /** Global channel store (channels + debounce). Bearer-gated. */
    getConfig(): Promise<NotificationsConfig>;
    /** Persist the global store (whole-config; server normalizes). */
    saveConfig(config: Partial<NotificationsConfig>): Promise<NotificationsConfig>;
    /** Recent in-memory delivery history, most-recent-first (≤100). */
    recent(limit?: number): Promise<NotificationDeliveryRecord[]>;
    /** Fire a one-off test to a single channel by id. */
    test(channelId: string): Promise<{ success: boolean; message?: string; status?: number }>;
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
