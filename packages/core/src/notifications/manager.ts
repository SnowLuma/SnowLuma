// The global notification subsystem: one singleton watching ALL accounts.
//
// Subscribes to BridgeManager session online/offline edges, runs a per-UIN
// debounce state machine (see debounce.ts), and on a fired transition renders
// each opted-in + enabled channel's template and delivers it — recording the
// outcome in a bounded in-memory history (lost on restart, by design).
//
// Side-effecting collaborators (config load, per-UIN channel ids, webhook POST,
// SMTP send, the clock) are injected so the class is fully unit-testable; the
// real wiring lives in `createNotificationManager()` at the bottom.
import { createLogger } from '@snowluma/common/logger';
import { loadOneBotConfig } from '@snowluma/onebot/config';
import type { BridgeManager } from '../bridge/manager';
import {
  isEmailChannel,
  loadNotificationsConfig,
  renderTemplate,
  type NotificationChannel,
  type NotificationEvent,
  type NotificationsConfig,
} from './config';
import { DebounceMachine, type DebounceDecision } from './debounce';
import { formatSmtpError, parseRecipients, sendSmtpMail } from './smtp';

const log = createLogger('Notifications');

const DEFAULT_HISTORY_LIMIT = 100;
const DEFAULT_POST_TIMEOUT_MS = 10_000;
const FALLBACK_DEBOUNCE_SECONDS = 30;

/** One delivery attempt; kept only in memory (the plan forbids persistence). */
export interface DeliveryRecord {
  time: number;
  uin: string;
  event: NotificationEvent;
  channelId: string;
  ok: boolean;
  status?: number;
  error?: string;
}

export interface PostResult {
  ok: boolean;
  status?: number;
  error?: string;
}

export interface MailPayload {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string;
  subject: string;
  text: string;
}

export interface NotificationManagerDeps {
  /** Global channel store (channels + debounceSeconds). */
  loadConfig: () => NotificationsConfig;
  /** The channel ids a UIN has opted into. */
  loadChannelIds: (uin: string) => string[];
  /** Webhook delivery — never throws; failures come back as `{ ok: false }`. */
  post: (url: string, body: string, headers?: Record<string, string>) => Promise<PostResult>;
  /** SMTP delivery — optional so webhook-only tests stay lean. */
  sendMail?: (mail: MailPayload) => Promise<PostResult>;
  now: () => number;
  historyLimit?: number;
}

function errMsg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}

/**
 * Pure: the channels a UIN should be notified through — globally enabled AND
 * opted into by the UIN — preserving config order. Exported for unit tests.
 */
export function selectChannels(channels: NotificationChannel[], enabledIds: string[]): NotificationChannel[] {
  const wanted = new Set(enabledIds);
  return channels.filter((c) => c.enabled && wanted.has(c.id));
}

export class NotificationManager {
  private readonly deps: NotificationManagerDeps;
  private readonly machine = new DebounceMachine();
  private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly nicknames = new Map<string, string>();
  private readonly history: DeliveryRecord[] = [];
  private readonly historyLimit: number;
  private disposed = false;

  constructor(deps: NotificationManagerDeps) {
    this.deps = deps;
    this.historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT;
  }

  /** Subscribe to the global session online/offline edges. Register AFTER
   *  OneBotManager so the nickname fallback is already populated. */
  bind(bridgeManager: BridgeManager): void {
    bridgeManager.addSessionStartedListener((uin, bridge) => this.handleOnline(uin, bridge.identity.nickname));
    bridgeManager.addSessionClosedListener((uin, bridge) => this.handleOffline(uin, bridge.identity.nickname));
  }

  handleOnline(uin: string, nickname?: string): void {
    if (this.disposed) return;
    if (nickname) this.nicknames.set(uin, nickname);
    this.apply(uin, this.machine.onOnline(uin));
  }

  handleOffline(uin: string, nickname?: string): void {
    if (this.disposed) return;
    if (nickname) this.nicknames.set(uin, nickname);
    this.apply(uin, this.machine.onOffline(uin, this.debounceSeconds()));
  }

  private debounceSeconds(): number {
    try {
      return this.deps.loadConfig().debounceSeconds;
    } catch {
      return FALLBACK_DEBOUNCE_SECONDS;
    }
  }

  private apply(uin: string, decision: DebounceDecision): void {
    switch (decision.kind) {
      case 'schedule': {
        const existing = this.timers.get(uin);
        if (existing) clearTimeout(existing);
        const timer = setTimeout(() => {
          this.timers.delete(uin);
          this.apply(uin, this.machine.onTimerElapsed(uin));
        }, decision.delayMs);
        // Don't let a pending notification timer keep the process alive.
        if (typeof (timer as { unref?: () => void }).unref === 'function') {
          (timer as { unref: () => void }).unref();
        }
        this.timers.set(uin, timer);
        break;
      }
      case 'cancel': {
        const timer = this.timers.get(uin);
        if (timer) {
          clearTimeout(timer);
          this.timers.delete(uin);
        }
        break;
      }
      case 'emit':
        void this.notify(uin, decision.event);
        break;
      case 'none':
        break;
    }
  }

  /** Render + deliver a transition to every opted-in, enabled channel and record
   *  the outcome. Never throws (a bad channel can't break the others). */
  async notify(uin: string, event: NotificationEvent): Promise<void> {
    let channels: NotificationChannel[];
    try {
      const cfg = this.deps.loadConfig();
      channels = selectChannels(cfg.channels, this.deps.loadChannelIds(uin));
    } catch (err) {
      log.warn('notify(%s, %s) skipped — config load failed: %s', uin, event, errMsg(err));
      return;
    }
    if (channels.length === 0) return;

    const nickname = this.nicknames.get(uin) || uin;
    const vars: Record<string, string> = {
      uin,
      nickname,
      event,
      time: new Date(this.deps.now()).toISOString(),
    };

    for (const ch of channels) {
      const result = await this.deliver(ch, vars);
      this.record({
        time: this.deps.now(),
        uin,
        event,
        channelId: ch.id,
        ok: result.ok,
        status: result.status,
        error: result.ok ? undefined : (result.error ?? (result.status ? `HTTP ${result.status}` : 'delivery failed')),
      });
      if (!result.ok) {
        log.warn('notify %s→%s channel=%s failed: %s', uin, event, ch.id, result.error ?? `HTTP ${result.status ?? '?'}`);
      }
    }
  }

  private async deliver(ch: NotificationChannel, vars: Record<string, string>): Promise<PostResult> {
    try {
      if (isEmailChannel(ch)) {
        const send = this.deps.sendMail;
        if (!send) return { ok: false, error: 'email delivery is not configured' };
        return await send({
          host: ch.smtpHost,
          port: ch.smtpPort,
          secure: ch.smtpSecure,
          user: ch.smtpUser,
          pass: ch.smtpPass,
          from: ch.from,
          to: ch.to,
          subject: renderTemplate(ch.subjectTemplate, vars),
          text: renderTemplate(ch.bodyTemplate, vars),
        });
      }
      return await this.deps.post(ch.url, renderTemplate(ch.bodyTemplate, vars), ch.headers);
    } catch (err) {
      // Injected collaborators are contracted not to throw, but guard anyway.
      return { ok: false, error: errMsg(err) };
    }
  }

  /** Send a one-off test to a single channel by id — ignores `enabled` and the
   *  per-UIN opt-in (you test a channel before wiring it up), with sample
   *  variables. Reuses the real render+deliver path; NOT recorded to history.
   *  `found:false` means the channel id is unknown. */
  async testSend(channelId: string): Promise<PostResult & { found: boolean }> {
    let channel: NotificationChannel | undefined;
    try {
      channel = this.deps.loadConfig().channels.find((c) => c.id === channelId);
    } catch (err) {
      return { ok: false, found: false, error: errMsg(err) };
    }
    if (!channel) return { ok: false, found: false };
    const vars = {
      uin: '10000',
      nickname: '测试账号',
      event: 'offline' as const,
      time: new Date(this.deps.now()).toISOString(),
    };
    return { ...(await this.deliver(channel, vars)), found: true };
  }

  private record(rec: DeliveryRecord): void {
    this.history.push(rec);
    if (this.history.length > this.historyLimit) {
      this.history.splice(0, this.history.length - this.historyLimit);
    }
  }

  /** Most-recent-first delivery history (capped at the buffer size). */
  getRecent(limit = this.historyLimit): DeliveryRecord[] {
    const n = Math.max(0, Math.min(Math.trunc(limit) || 0, this.history.length));
    return this.history.slice(this.history.length - n).reverse();
  }

  dispose(): void {
    if (this.disposed) return;
    this.disposed = true;
    for (const timer of this.timers.values()) clearTimeout(timer);
    this.timers.clear();
  }
}

/** Default outbound POST: a single attempt with a timeout, JSON content-type
 *  (the common case for 钉钉/Discord/飞书). Never throws. */
export function createDefaultPost(timeoutMs = DEFAULT_POST_TIMEOUT_MS): NotificationManagerDeps['post'] {
  return async (url, body, headers) => {
    try {
      const res = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', ...headers },
        body,
        signal: AbortSignal.timeout(timeoutMs),
      });
      return { ok: res.ok, status: res.status, error: res.ok ? undefined : `HTTP ${res.status}` };
    } catch (err) {
      return { ok: false, error: errMsg(err) };
    }
  };
}

const DEFAULT_SMTP_TIMEOUT_MS = 15_000;

/** Default SMTP send. Never throws. */
export function createDefaultSendMail(timeoutMs = DEFAULT_SMTP_TIMEOUT_MS): NonNullable<NotificationManagerDeps['sendMail']> {
  return async (mail) => {
    try {
      await sendSmtpMail({
        host: mail.host,
        port: mail.port,
        secure: mail.secure,
        user: mail.user,
        pass: mail.pass,
        from: mail.from,
        to: parseRecipients(mail.to),
        subject: mail.subject,
        body: mail.text,
      }, { timeoutMs });
      return { ok: true };
    } catch (err) {
      return { ok: false, error: formatSmtpError(err, mail.host, mail.port) };
    }
  };
}

/** The real, fully-wired singleton. */
export function createNotificationManager(): NotificationManager {
  return new NotificationManager({
    loadConfig: loadNotificationsConfig,
    loadChannelIds: (uin) => loadOneBotConfig(uin).notifications?.channelIds ?? [],
    post: createDefaultPost(),
    sendMail: createDefaultSendMail(),
    now: () => Date.now(),
  });
}
