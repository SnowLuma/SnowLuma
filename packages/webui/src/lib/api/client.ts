import type { AccountConnections, BackupBundle, BackupImportResult, DebugActionDoc, DebugInvokeResult, DebugStreamMessage, GlobalSettings, HookProcessInfo, LogEntry, LogLevel, NotificationDeliveryRecord, NotificationsConfig, QQInfo, SystemInfo, SystemSettingsPatch, SystemSettingsResponse, UiAppearance, UiConfig, UpdateInfo } from '@/types';
import type { PasswordRule } from '@/components/pages/change-password-page';
import { normalizeOneBotConfig } from '@/lib/onebot-config';
import {
  type AgreementsPayload,
  ApiError,
  type ApiClient,
  type ChangePasswordResult,
  type CreateApiClientOptions,
  type LoginResult,
  type LogsStreamOptions,
  type ProcessActionResult,
  type StateStreamEvent,
  type StateStreamOptions,
  type TokenStore,
} from './types';
import { localStorageTokenStore } from './token-store';

const DEFAULT_TOKEN_KEY = 'snowluma_token';

interface ErrorPayload {
  message?: string;
  error?: string;
  code?: string;
}

async function readJson<T>(res: Response): Promise<T> {
  try {
    return (await res.json()) as T;
  } catch {
    return {} as T;
  }
}

function extractErrorMessage(payload: ErrorPayload, fallback: string): string {
  return payload.message || payload.error || fallback;
}

class HttpApiClient implements ApiClient {
  private tokenStore: TokenStore;
  private currentToken: string | null;
  private onUnauthorized?: () => void;

  // namespaced surfaces are bound up-front so callers can destructure
  readonly processes: ApiClient['processes'];
  readonly config: ApiClient['config'];
  readonly logs: ApiClient['logs'];
  readonly update: ApiClient['update'];
  readonly ui: ApiClient['ui'];
  readonly notifications: ApiClient['notifications'];
  readonly globalConfig: ApiClient['globalConfig'];
  readonly systemSettings: ApiClient['systemSettings'];
  readonly debug: ApiClient['debug'];
  readonly agreements: ApiClient['agreements'];

  constructor(opts: CreateApiClientOptions = {}) {
    this.tokenStore = opts.tokenStore ?? localStorageTokenStore(DEFAULT_TOKEN_KEY);
    this.currentToken = this.tokenStore.load();
    this.onUnauthorized = opts.onUnauthorized;

    this.processes = {
      list: () => this.getJson<{ list: HookProcessInfo[] }>('/api/processes').then((d) => d.list ?? []),
      load: (pid) => this.postJson<ProcessActionResult>(`/api/processes/${pid}/load`),
      unload: (pid) => this.postJson<ProcessActionResult>(`/api/processes/${pid}/unload`),
      refresh: (pid) => this.postJson<ProcessActionResult>(`/api/processes/${pid}/refresh`),
      probeLoginInfo: (pid) => this.getJson<{ info: unknown }>(`/api/processes/${pid}/probe-login`).then((d) => d.info ?? null),
    };

    this.config = {
      get: async (uin) => {
        const url = `/api/config/${encodeURIComponent(uin)}`;
        const data = await this.getJson<{ config?: unknown } | unknown>(url);
        const raw =
          typeof data === 'object' && data != null && 'config' in (data as Record<string, unknown>)
            ? (data as { config: unknown }).config
            : data;
        return normalizeOneBotConfig(raw);
      },
      save: async (uin, config) => {
        const url = `/api/config/${encodeURIComponent(uin)}`;
        // POST returns { success, reloaded, message } — no config body. To
        // honour the "save returns canonical server view" contract, refetch
        // after a successful POST.
        await this.fetchJson<unknown>(url, {
          method: 'POST',
          body: JSON.stringify(config),
        });
        return this.config.get(uin);
      },
    };

    this.logs = {
      list: async (limit = 500) => {
        const data = await this.getJson<{ list: LogEntry[] }>(`/api/logs?limit=${limit}`);
        return data.list ?? [];
      },
      stream: (options) => this.openLogStream(options),
      getLevel: () => this.getJson<{ level: LogLevel; levels: LogLevel[] }>(`/api/logs/level`),
      setLevel: (level) =>
        this.postJson<{ level: LogLevel; levels: LogLevel[] }>(`/api/logs/level`, { level }),
    };

    this.update = {
      check: (force) =>
        this.getJson<UpdateInfo>(`/api/update/check${force ? '?force=true' : ''}`),
    };

    this.systemSettings = {
      get: () => this.getJson<SystemSettingsResponse>('/api/system/settings'),
      save: (patch: SystemSettingsPatch) =>
        this.postJson<{ settings: SystemSettingsResponse['settings']; restartRequiredToApply: boolean }>(
          '/api/system/settings',
          patch,
        ),
      uploadCert: async (cert: string, key: string) => {
        await this.postJson<{ success: boolean }>('/api/system/tls/cert', { cert, key });
      },
      deleteCert: async () => {
        await this.fetchJson<{ success: boolean }>('/api/system/tls/cert', { method: 'DELETE' });
      },
      exportBackup: (includeCredentials: boolean) =>
        this.getJson<BackupBundle>(`/api/system/backup/export${includeCredentials ? '?credentials=1' : ''}`),
      importBackup: (backup: BackupBundle, restoreCredentials: boolean) =>
        this.postJson<BackupImportResult>('/api/system/backup/import', { backup, restoreCredentials }),
    };

    this.debug = {
      actions: () => this.getJson<{ actions: DebugActionDoc[]; categories: { category: string; count: number }[] }>('/api/debug/actions'),
      invoke: (uin: string, action: string, params: Record<string, unknown>) =>
        this.postJson<DebugInvokeResult>('/api/debug/invoke', { uin, action, params }),
      stream: (onMessage, onStatus) => this.openDebugStream(onMessage, onStatus),
    };

    this.ui = {
      get: () => this.getJson<{ config: UiConfig }>('/api/ui').then((d) => d.config),
      save: async (config) => {
        const data = await this.postJson<{ config: UiConfig }>('/api/ui', config);
        return data.config;
      },
      getPublic: async () => {
        // Pre-auth path: a plain fetch with no bearer. Used by the login page
        // to theme itself before the operator has signed in.
        const res = await fetch('/api/ui/public');
        if (!res.ok) throw new ApiError(res.status, '无法获取外观配置');
        const data = await readJson<{ appearance: UiAppearance }>(res);
        return data.appearance;
      },
      uploadBackground: async (file) => {
        // FormData must set its own multipart boundary, so this bypasses
        // request() (which would force application/json) and attaches the
        // bearer header directly — mirroring login()'s deliberate bypass.
        const form = new FormData();
        form.append('file', file);
        const headers: Record<string, string> = {};
        if (this.currentToken) headers['Authorization'] = `Bearer ${this.currentToken}`;
        const res = await fetch('/api/ui/background', { method: 'POST', headers, body: form });
        if (res.status === 401) {
          this.setToken(null);
          this.onUnauthorized?.();
        }
        if (!res.ok) {
          const payload = await readJson<ErrorPayload>(res);
          throw new ApiError(res.status, extractErrorMessage(payload, '上传失败'), payload.code);
        }
        const data = await readJson<{ config: UiConfig }>(res);
        return data.config;
      },
      deleteBackground: async () => {
        const data = await this.fetchJson<{ config: UiConfig }>('/api/ui/background', { method: 'DELETE' });
        return data.config;
      },
    };

    this.notifications = {
      getConfig: () =>
        this.getJson<{ config: NotificationsConfig }>('/api/notifications/config').then((d) => d.config),
      saveConfig: async (config) => {
        const data = await this.postJson<{ success: boolean; config: NotificationsConfig }>(
          '/api/notifications/config',
          config,
        );
        return data.config;
      },
      recent: (limit) =>
        this.getJson<{ recent: NotificationDeliveryRecord[] }>(
          `/api/notifications/recent${limit ? `?limit=${limit}` : ''}`,
        ).then((d) => d.recent ?? []),
      test: (channelId) =>
        this.postJson<{ success: boolean; message?: string; status?: number }>('/api/notifications/test', {
          channelId,
        }),
    };

    this.globalConfig = {
      get: () =>
        this.getJson<{ config: GlobalSettings }>('/api/global-config').then((d) => d.config),
      save: async (config) => {
        const data = await this.postJson<{ success: boolean; config: GlobalSettings }>(
          '/api/global-config',
          config,
        );
        return data.config;
      },
    };

    this.agreements = {
      get: () => this.getJson<AgreementsPayload>('/api/agreements'),
      recordConsent: async (version) => {
        // Read the body even on non-2xx so a 409 can surface currentVersion to
        // the caller (instead of fetchJson throwing it away as an ApiError).
        // A network failure (fetch reject) must resolve to {success:false}, not
        // throw, or the consent button hangs on "提交中…" with no error shown.
        try {
          const res = await this.request('/api/agreements/record-consent', {
            method: 'POST',
            body: JSON.stringify({ version }),
          });
          const data = await readJson<{ success?: boolean; message?: string; currentVersion?: string }>(res);
          return { success: res.ok && !!data.success, message: data.message, currentVersion: data.currentVersion };
        } catch (e) {
          return { success: false, message: e instanceof Error ? e.message : '网络错误，请重试' };
        }
      },
    };
  }

  // ---------- HTTP helpers ----------

  async request(url: string, init: RequestInit = {}): Promise<Response> {
    const headers: Record<string, string> = {
      ...((init.headers as Record<string, string> | undefined) ?? {}),
    };
    if (this.currentToken) headers['Authorization'] = `Bearer ${this.currentToken}`;
    if (init.body && !headers['Content-Type']) headers['Content-Type'] = 'application/json';
    const res = await fetch(url, { ...init, headers });
    if (res.status === 401) {
      this.setToken(null);
      this.onUnauthorized?.();
    }
    return res;
  }

  /** Like request(), but throws ApiError on non-2xx and parses JSON. */
  private async fetchJson<T>(url: string, init: RequestInit = {}): Promise<T> {
    const res = await this.request(url, init);
    if (!res.ok) {
      const payload = await readJson<ErrorPayload>(res);
      throw new ApiError(res.status, extractErrorMessage(payload, res.statusText || '请求失败'), payload.code);
    }
    return readJson<T>(res);
  }

  private getJson<T>(url: string): Promise<T> {
    return this.fetchJson<T>(url);
  }

  private postJson<T>(url: string, body?: unknown): Promise<T> {
    return this.fetchJson<T>(url, {
      method: 'POST',
      body: body == null ? undefined : JSON.stringify(body),
    });
  }

  // ---------- token management ----------

  private setToken(token: string | null): void {
    this.currentToken = token;
    this.tokenStore.save(token);
  }

  // ---------- auth ----------

  async login(password: string): Promise<LoginResult> {
    // Login deliberately bypasses fetchJson/onUnauthorized so a bad password
    // doesn't trigger a global sign-out side effect.
    try {
      const res = await fetch('/api/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });
      if (!res.ok) {
        const payload = await readJson<ErrorPayload>(res);
        return { ok: false, message: extractErrorMessage(payload, '令牌错误') };
      }
      const payload = await readJson<{ token: string; mustChangePassword?: boolean }>(res);
      this.setToken(payload.token);
      return { ok: true, mustChangePassword: !!payload.mustChangePassword };
    } catch (e) {
      return { ok: false, message: e instanceof Error ? e.message : '网络错误' };
    }
  }

  async logout(): Promise<void> {
    try {
      await this.request('/api/logout', { method: 'POST' });
    } catch {
      /* ignore */
    }
    this.setToken(null);
  }

  async status(): Promise<boolean> {
    if (!this.currentToken) return false;
    try {
      const res = await this.request('/api/status');
      return res.ok;
    } catch {
      return false;
    }
  }

  async mustChangePassword(): Promise<boolean> {
    try {
      const data = await this.getJson<{ mustChangePassword?: boolean }>('/api/auth/state');
      return !!data.mustChangePassword;
    } catch {
      return false;
    }
  }

  async checkPasswordStrength(password: string): Promise<{ rules: PasswordRule[]; valid: boolean }> {
    try {
      const data = await this.postJson<{ rules?: PasswordRule[]; valid?: boolean }>(
        '/api/auth/check-strength',
        { password },
      );
      return { rules: data.rules ?? [], valid: !!data.valid };
    } catch {
      return { rules: [], valid: false };
    }
  }

  async changePassword(oldPassword: string, newPassword: string): Promise<ChangePasswordResult> {
    try {
      const data = await this.postJson<{ success?: boolean; message?: string }>(
        '/api/auth/change-password',
        { oldPassword, newPassword },
      );
      return { success: !!data.success, message: data.message };
    } catch (e) {
      if (e instanceof ApiError) return { success: false, message: e.message };
      return { success: false, message: e instanceof Error ? e.message : '网络错误' };
    }
  }

  // ---------- top-level resources ----------

  async qqList(): Promise<QQInfo[]> {
    const data = await this.getJson<{ list: QQInfo[] }>('/api/qq-list');
    return data.list ?? [];
  }

  system(): Promise<SystemInfo> {
    return this.getJson<SystemInfo>('/api/system');
  }

  connections(): Promise<AccountConnections[]> {
    return this.getJson<{ list: AccountConnections[] }>('/api/connections').then((d) => d.list ?? []);
  }

  stateStream(options: StateStreamOptions): () => void {
    if (!this.currentToken) { options.onStatus?.('closed'); return () => {}; }
    const url = `/api/state/stream?token=${encodeURIComponent(this.currentToken)}`;
    const source = new EventSource(url);
    // EventSource auto-reconnects on transport drop: `onerror` fires once
    // when the connection is lost and the browser is about to retry, so
    // a single 'reconnecting' status is sufficient — no manual reconnect
    // timer needed.
    source.onopen = () => options.onStatus?.('open');
    source.onerror = () => options.onStatus?.('reconnecting');
    source.onmessage = (event) => {
      try {
        options.onEvent(JSON.parse(event.data) as StateStreamEvent);
      } catch {
        /* malformed frame — skip; the next one will arrive normally */
      }
    };
    return () => { source.close(); options.onStatus?.('closed'); };
  }

  // ---------- SSE ----------

  private openLogStream(options: LogsStreamOptions): () => void {
    if (!this.currentToken) {
      options.onStatus?.('closed');
      return () => {};
    }
    const url = `/api/logs/stream?token=${encodeURIComponent(this.currentToken)}`;
    const source = new EventSource(url);
    source.onopen = () => options.onStatus?.('open');
    source.onerror = () => options.onStatus?.('reconnecting');
    source.onmessage = (event) => {
      try {
        const parsed = JSON.parse(event.data) as LogEntry | { type: string };
        if ('type' in parsed) return; // control frame, not a log line
        options.onLine(parsed);
      } catch {
        /* malformed frame, skip */
      }
    };
    return () => {
      source.close();
      options.onStatus?.('closed');
    };
  }

  private openDebugStream(
    onMessage: (m: DebugStreamMessage) => void,
    onStatus?: (s: import('./types').StreamStatus) => void,
  ): () => void {
    if (!this.currentToken) { onStatus?.('closed'); return () => {}; }
    const url = `/api/debug/stream?token=${encodeURIComponent(this.currentToken)}`;
    const source = new EventSource(url);
    source.onopen = () => onStatus?.('open');
    source.onerror = () => onStatus?.('reconnecting');
    source.onmessage = (event) => {
      try { onMessage(JSON.parse(event.data) as DebugStreamMessage); } catch { /* skip malformed */ }
    };
    return () => { source.close(); onStatus?.('closed'); };
  }
}

export function createApiClient(options: CreateApiClientOptions = {}): ApiClient {
  return new HttpApiClient(options);
}
