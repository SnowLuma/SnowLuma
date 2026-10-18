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
import { positiveIntEnv } from '@snowluma/common/env';
import { errorMessage } from '@snowluma/common/errors';
import type { HookProcessInfo } from '@snowluma/bridge/types';
import { createLogger } from '@snowluma/common/logger';
import { loadOneBotConfig } from '@snowluma/onebot/config';
import type { BridgeSessionSource } from '../bridge/bridge-interface';
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

/** One delivery attempt, retained in bounded in-memory history. */
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

/**
 * Optional hook process snapshot attached to a notification. Missing facts
 * mean unknown, not proof that QQ exited. Hook status describes connectivity;
 * it does not by itself identify the reason an account went offline.
 * Undefined fields render empty in templates.
 */
export type NotificationProcessFacts = Partial<Pick<HookProcessInfo, 'status' | 'pid' | 'error'>>;

export interface NotificationManagerDeps {
    /** Global channel store (channels + debounceSeconds). */
    loadConfig: () => NotificationsConfig;
    /** The channel ids a UIN has opted into. */
    loadChannelIds: (uin: string) => string[];
    /** Webhook delivery. Rejections are recorded as failed attempts. */
    post: (url: string, body: string, headers?: Record<string, string>) => Promise<PostResult>;
    /** SMTP delivery — optional so webhook-only tests stay lean. */
    sendMail?: (mail: MailPayload) => Promise<PostResult>;
    now: () => number;
    historyLimit?: number;
    /**
     * Optional: look up the lifecycle event's PID and UIN at dispatch time. Omitted
     * (or resolving to `undefined`) means "process unknown" — the fact
     * variables then render empty rather than leaving `{status}` in the body.
     */
    resolveProcess?: (
        uin: string,
        pid: number | null,
    ) => Promise<NotificationProcessFacts | undefined>;
}

interface AccountNotificationContext {
    nickname: string;
    pid: number | null;
}

/**
 * Pure: the channels a UIN should be notified through — globally enabled AND
 * opted into by the UIN — preserving config order. Exported for unit tests.
 */
export function selectChannels(
    channels: NotificationChannel[],
    enabledIds: string[],
): NotificationChannel[] {
    const wanted = new Set(enabledIds);
    return channels.filter((c) => c.enabled && wanted.has(c.id));
}

export class NotificationManager {
    private readonly deps: NotificationManagerDeps;
    private readonly machine = new DebounceMachine();
    private readonly timers = new Map<string, ReturnType<typeof setTimeout>>();
    private readonly accounts = new Map<string, AccountNotificationContext>();
    private readonly history: DeliveryRecord[] = [];
    private readonly deliveries = new Map<string, Promise<void>>();
    private readonly historyLimit: number;
    private disposed = false;
    private unsubscribeSessions: (() => void) | null = null;

    constructor(deps: NotificationManagerDeps) {
        this.deps = deps;
        this.historyLimit = deps.historyLimit ?? DEFAULT_HISTORY_LIMIT;
    }

    /** Subscribe to the global session online/offline edges. Register AFTER
     *  OneBotManager so the nickname fallback is already populated. */
    bind(bridgeManager: BridgeSessionSource): void {
        if (this.disposed) {
            return;
        }

        this.unsubscribeSessions?.();
        this.unsubscribeSessions = bridgeManager.subscribeSessions({
            started: (uin, bridge) =>
                this.handleOnline(uin, bridge.identity.nickname, bridge.activePid),
            closed: (uin, bridge, pid) => this.handleOffline(uin, bridge.identity.nickname, pid),
        });
    }

    handleOnline(uin: string, nickname?: string, pid: number | null = null): void {
        if (this.disposed) {
            return;
        }

        this.accounts.set(uin, {
            nickname: nickname || this.accounts.get(uin)?.nickname || uin,
            pid,
        });

        this.apply(uin, this.machine.onOnline(uin));
    }

    handleOffline(uin: string, nickname?: string, pid: number | null = null): void {
        if (this.disposed) {
            return;
        }

        let debounceSeconds: number;

        try {
            debounceSeconds = this.deps.loadConfig().debounceSeconds;
        } catch (err) {
            log.warn('offline(%s) skipped — config load failed: %s', uin, errorMessage(err));
            return;
        }

        this.accounts.set(uin, {
            nickname: nickname || this.accounts.get(uin)?.nickname || uin,
            pid,
        });

        this.apply(uin, this.machine.onOffline(uin, debounceSeconds));
    }

    private apply(uin: string, decision: DebounceDecision): void {
        switch (decision.kind) {
            case 'schedule': {
                const timer = setTimeout(() => {
                    this.timers.delete(uin);
                    this.apply(uin, this.machine.onTimerElapsed(uin));
                }, decision.delayMs);

                // Don't let a pending notification timer keep the process alive.
                timer.unref();
                this.timers.set(uin, timer);
                break;
            }

            case 'cancel': {
                clearTimeout(this.timers.get(uin));
                this.timers.delete(uin);
                break;
            }

            case 'emit':
                void this.notify(uin, decision.event);
                break;
            case 'none':
                break;
        }
    }

    /** Queue one transition; channel failures are recorded independently. */
    notify(uin: string, event: NotificationEvent): Promise<void> {
        if (this.disposed) {
            return Promise.resolve();
        }

        const account = this.accounts.get(uin) ?? { nickname: uin, pid: null };
        const previous = this.deliveries.get(uin) ?? Promise.resolve();
        // Both enrichment and every channel delivery belong to this transition.
        // A slow lookup/send must not let recovery overtake offline for one UIN.
        const delivery = previous
            .then(() => this.notifyNow(uin, event, account))
            .finally(() => {
                if (this.deliveries.get(uin) === delivery) {
                    this.deliveries.delete(uin);
                }
            });
        this.deliveries.set(uin, delivery);
        return delivery;
    }

    private async notifyNow(
        uin: string,
        event: NotificationEvent,
        account: AccountNotificationContext,
    ): Promise<void> {
        if (this.disposed) {
            return;
        }

        let channels: NotificationChannel[];

        try {
            const cfg = this.deps.loadConfig();
            channels = selectChannels(cfg.channels, this.deps.loadChannelIds(uin));
        } catch (err) {
            log.warn(
                'notify(%s, %s) skipped — config load failed: %s',
                uin,
                event,
                errorMessage(err),
            );
            return;
        }

        if (channels.length === 0) {
            return;
        }

        let facts: NotificationProcessFacts | undefined;

        try {
            facts = await this.deps.resolveProcess?.(uin, account.pid);
        } catch (err) {
            log.warn('resolveProcess(%s, %s) failed: %s', uin, account.pid, errorMessage(err));
        }

        const vars: Record<string, string> = {
            uin,
            nickname: account.nickname,
            event,
            time: new Date(this.deps.now()).toISOString(),
            status: facts?.status ?? '',
            pid: facts?.pid === undefined ? '' : String(facts.pid),
            error: facts?.error ?? '',
        };

        for (const ch of channels) {
            if (this.disposed) {
                return;
            }

            const result = await this.deliver(ch, vars);
            this.record({
                time: this.deps.now(),
                uin,
                event,
                channelId: ch.id,
                ok: result.ok,
                status: result.status,
                error: result.ok
                    ? undefined
                    : (result.error ??
                      (result.status ? `HTTP ${result.status}` : 'delivery failed')),
            });

            if (!result.ok) {
                log.warn(
                    'notify %s→%s channel=%s failed: %s',
                    uin,
                    event,
                    ch.id,
                    result.error ?? `HTTP ${result.status ?? '?'}`,
                );
            }
        }
    }

    private async deliver(
        ch: NotificationChannel,
        vars: Record<string, string>,
    ): Promise<PostResult> {
        try {
            if (isEmailChannel(ch)) {
                const send = this.deps.sendMail;

                if (!send) {
                    return { ok: false, error: 'email delivery is not configured' };
                }

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
            return { ok: false, error: errorMessage(err) };
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
            return { ok: false, found: false, error: errorMessage(err) };
        }

        if (!channel) {
            return { ok: false, found: false };
        }

        const vars = {
            uin: '10000',
            nickname: '测试账号',
            event: 'offline' as const,
            time: new Date(this.deps.now()).toISOString(),
            status: 'disconnected',
            pid: '1234',
            error: '',
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
        if (this.disposed) {
            return;
        }

        this.disposed = true;
        this.unsubscribeSessions?.();
        this.unsubscribeSessions = null;

        for (const timer of this.timers.values()) {
            clearTimeout(timer);
        }

        this.timers.clear();
    }
}

/** Default outbound POST: a single attempt with a timeout, JSON content-type
 *  (the common case for 钉钉/Discord/飞书). Never throws. */
export function createDefaultPost(
    timeoutMs = positiveIntEnv('SNOWLUMA_NOTIFICATION_HTTP_TIMEOUT_MS', DEFAULT_POST_TIMEOUT_MS),
): NotificationManagerDeps['post'] {
    return async (url, body, headers) => {
        try {
            const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', ...headers },
                body,
                signal: AbortSignal.timeout(timeoutMs),
            });
            return {
                ok: res.ok,
                status: res.status,
                error: res.ok ? undefined : `HTTP ${res.status}`,
            };
        } catch (err) {
            return { ok: false, error: errorMessage(err) };
        }
    };
}

const DEFAULT_SMTP_TIMEOUT_MS = 15_000;

/** Default SMTP send. Never throws. */
export function createDefaultSendMail(
    timeoutMs = DEFAULT_SMTP_TIMEOUT_MS,
): NonNullable<NotificationManagerDeps['sendMail']> {
    return async (mail) => {
        try {
            await sendSmtpMail(
                {
                    host: mail.host,
                    port: mail.port,
                    secure: mail.secure,
                    user: mail.user,
                    pass: mail.pass,
                    from: mail.from,
                    to: parseRecipients(mail.to),
                    subject: mail.subject,
                    body: mail.text,
                },
                { timeoutMs },
            );
            return { ok: true };
        } catch (err) {
            return { ok: false, error: formatSmtpError(err, mail.host, mail.port) };
        }
    };
}

/** The real, fully-wired singleton. `resolveProcess` is supplied by the
 *  runtime — this package deliberately knows nothing about HookManager. */
export function createNotificationManager(
    resolveProcess?: NotificationManagerDeps['resolveProcess'],
): NotificationManager {
    return new NotificationManager({
        loadConfig: loadNotificationsConfig,
        loadChannelIds: (uin) => loadOneBotConfig(uin).notifications?.channelIds ?? [],
        post: createDefaultPost(),
        sendMail: createDefaultSendMail(),
        now: () => Date.now(),
        resolveProcess,
    });
}
