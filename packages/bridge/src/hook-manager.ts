import { createLogger, runWithTraceRequest, type Logger } from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo, PacketSink } from '@snowluma/common/protocol-types';
import fs from 'fs';
import { HookSession, type HookSessionDeps } from './hook-session';
import {
    injectHookProcess,
    listHookProcesses,
    resolveHookNativePath,
    unloadHookProcess,
    type HookProcessBaseInfo,
} from './injector';
import { PipeWatcher } from './pipe-watcher';
import { createNativeProcessEnumerator, type ProcessEnumerator } from './process-enumerator';
import { QqHookClient } from './qq-hook-client';
import { detectAccountLoginsForPids, type AccountLoginState } from './qq-account';
import type { HookProcessAccount, HookProcessInfo } from './types';

const AUTO_LOAD_MAX_ATTEMPTS = 3;

const DEFAULT_ACCOUNT_REPROBE_INTERVAL_MS = 5000;

type AutoLoadAttempt = {
    attempts: number;
    inFlight: boolean;
};

/**
 * Sink that the hook layer calls back into when it observes a new login,
 * a parsed packet, or a PID disconnect. The concrete implementation lives
 * in @snowluma/core (`BridgeManager`), which is wired in by the top-level
 * app entry. Declaring it here keeps @snowluma/bridge free of any
 * dependency on @snowluma/core — the hook package is self-contained.
 */
export interface BridgeManagerSink {
    onHookLogin(pid: number, uin: string, packetClient: PacketSender): void;
    onPacket(pkt: PacketInfo): void;
    onPidDisconnected(pid: number): void;
    onPidReceiveHealthChanged(pid: number, healthy: boolean): void;
}

export type HookManagerDeps = {
    bridgeManager: BridgeManagerSink;
    /** Sink for parsed packets from any live HookSession. Defaults to
     * `bridgeManager.onPacket` — every packet flows straight into the
     * per-UIN bridge dispatcher with no intermediate event emitter. */
    onPacket?: PacketSink;
    /** Native injector entrypoints. Defaults to the real native addon. */
    injector?: HookSessionDeps['injector'];
    /** Hook pipe-client factory. Defaults to `new QqHookClient(pid)`. */
    makeClient?: HookSessionDeps['makeClient'];
    /** Pre-built watcher. Defaults to a PipeWatcher wrapping the native listings. */
    pipeWatcher?: PipeWatcher;
    /** Polling interval for the default watcher. Ignored if `pipeWatcher` is provided. */
    watcherIntervalMs?: number;
    /** Native process lister used by `listProcesses()`. Defaults to the native addon. */
    listProcesses?: () => HookProcessBaseInfo[];
    /** Local account detection used to label each process with the account QQ is
     *  signed in as. Receives the pids to label so each one is resolved against
     *  the HOME it actually runs under (a container can give every QQ instance
     *  its own). Defaults to reading QQ's own account data. */
    detectAccounts?: (pids: readonly number[]) => Promise<AccountLoginState[]>;
    /** How often the watcher re-probes the account label of each process, in
     *  milliseconds. Defaults to `DEFAULT_ACCOUNT_REPROBE_INTERVAL_MS`. */
    accountReprobeIntervalMs?: number;
    /** When true, every newly-discovered QQ process is auto-injected (fires
     * `loadProcess(pid)` from the watcher's 'process-discovered' handler).
     * Failed loads are logged and leave the session in the 'error' state.
     * A narrowly-classified early-process mapping race is retried on later
     * watcher ticks with a fixed attempt limit. */
    autoLoadOnDiscovery?: boolean;
    /** Optional hook fired whenever the set of HookProcessInfo observable to
     * `listProcesses()` changes — new process discovered, process gone, or
     * any session's status mutated. Used by the WebUI SSE wiring to push a
     * fresh processes snapshot to connected clients without REST polling.
     * Exceptions thrown by the callback are caught and logged; they do not
     * break the watcher / session event loops. */
    onSessionsChanged?: () => void;
    log?: Logger;
};

/**
 * HookManager — thin orchestrator over a per-PID HookSession map and a
 * singleton PipeWatcher.
 *
 * Responsibilities:
 *   - Route user commands (load/unload/refresh) to the matching session.
 *   - Route watcher diff events to the matching session.
 *   - Forward session events ('login' / 'disconnected' / transport health) to BridgeManager.
 *   - Retry stuck-in-connecting sessions on every watcher tick (so a
 *     failed connect eventually recovers without a manual refresh).
 *   - Retry the bounded early-process auto-load race without retrying
 *     permanent injector errors.
 *
 * The native injector, native pipe-client, and native process/pipe
 * listings are all swappable dependencies so tests can run without a
 * real QQ.exe or a native addon.
 */
export class HookManager {
    private readonly bridgeManager: BridgeManagerSink;
    private readonly onPacket: PacketSink;
    private readonly injector: HookSessionDeps['injector'];
    private readonly makeClient: HookSessionDeps['makeClient'];
    private readonly pipeWatcher: PipeWatcher;
    private readonly ownsPipeWatcher: boolean;
    /** Watcher/API process enumeration — isolated + timeout-bounded by default
     *  so a blocked native /proc walk can't freeze the loop (issue #158).
     *  Resolves to `null` (UNKNOWN) on timeout/failure. */
    private readonly enumerate: () => Promise<HookProcessBaseInfo[] | null>;
    /** The owned enumerator (worker lifecycle), or null when a custom lister was
     *  injected (tests) — nothing to tear down in that case. */
    private readonly enumerator: ProcessEnumerator | null;
    private readonly detectAccounts: (pids: readonly number[]) => Promise<AccountLoginState[]>;
    private readonly accountReprobeIntervalMs: number;
    private readonly autoLoadOnDiscovery: boolean;
    private readonly onSessionsChangedRaw?: () => void;
    private readonly log: Logger;
    private readonly sessions = new Map<number, HookSession>();
    private readonly autoLoadAttempts = new Map<number, AutoLoadAttempt>();
    private readonly startPromise: Promise<void>;

    private accounts = new Map<number, HookProcessAccount>();
    private accountProbe: Promise<void> | null = null;
    private nextAccountProbeAt = 0;
    private lastAccountProbeFailure = '';

    private disposed = false;

    constructor(deps: HookManagerDeps) {
        this.bridgeManager = deps.bridgeManager;
        this.onPacket = deps.onPacket ?? ((pkt) => deps.bridgeManager.onPacket(pkt));
        this.onSessionsChangedRaw = deps.onSessionsChanged;
        this.log = deps.log ?? createLogger('Hook');

        this.injector = deps.injector ?? {
            inject: injectHookProcess,
            unload: (pid, handle) => {
                if (!handle) {
                    return;
                }

                unloadHookProcess(pid, handle);
            },
        };
        this.makeClient = deps.makeClient ?? ((pid: number) => new QqHookClient(pid));
        this.detectAccounts = deps.detectAccounts ?? detectAccountLoginsForPids;
        this.accountReprobeIntervalMs =
            deps.accountReprobeIntervalMs ?? DEFAULT_ACCOUNT_REPROBE_INTERVAL_MS;
        this.autoLoadOnDiscovery = deps.autoLoadOnDiscovery ?? false;

        // A custom lister (tests) is used directly — no worker, no isolation, just
        // an async wrap that maps a throw to the UNKNOWN sentinel. The default path
        // wraps the native enumerator in a worker with a timeout.
        if (deps.listProcesses) {
            const lister = deps.listProcesses;
            this.enumerator = null;

            this.enumerate = async () => {
                try {
                    return await lister();
                } catch (error) {
                    this.log.warn('listProcesses failed: %s', errMsg(error));
                    return null;
                }
            };
        } else {
            this.enumerator = createNativeProcessEnumerator({
                addonPath: resolveHookNativePath('node'),
                fallbackSync: listHookProcesses,
                processName: defaultProcessName(),
                log: this.log,
            });
            this.enumerate = () => this.enumerator!.enumerate();
        }

        if (deps.pipeWatcher) {
            this.pipeWatcher = deps.pipeWatcher;
            this.ownsPipeWatcher = false;
        } else {
            this.pipeWatcher = new PipeWatcher({
                listProcesses: this.enumerate,
                listLivePipes: (processes) =>
                    QqHookClient.listLivePipes(processes.map(({ pid }) => pid)),
                intervalMs: deps.watcherIntervalMs,
                log: this.log,
            });
            this.ownsPipeWatcher = true;
        }

        this.bindWatcher();
        this.startPromise = this.pipeWatcher.start();
    }

    // ─────────────── public API (unchanged from prior HookManager) ───────────────

    async listProcesses(): Promise<HookProcessInfo[]> {
        await this.startPromise;
        const processes = await this.enumerate();
        // A failed enumeration preserves the last known process set.
        const sessions =
            processes === null
                ? [...this.sessions.values()]
                : processes.map((proc) => {
                      const session = this.ensureSession(proc.pid);
                      session.attachProcessInfo(proc);
                      return session;
                  });
        await this.refreshAccounts();
        return sessions
            .filter((session) => this.sessions.get(session.pid) === session)
            .map((session) => this.processInfo(session))
            .sort((a, b) => a.pid - b.pid);
    }

    async loadProcess(pid: number): Promise<HookProcessInfo> {
        this.assertValidPid(pid);
        await this.startPromise;
        this.autoLoadAttempts.delete(pid);
        const session = this.ensureSession(pid);
        await session.load();
        this.pipeWatcher.wake();
        await this.refreshAccounts();
        return this.processInfo(session);
    }

    async unloadProcess(pid: number): Promise<HookProcessInfo> {
        this.assertValidPid(pid);
        await this.startPromise;
        this.autoLoadAttempts.delete(pid);
        const session = this.ensureSession(pid);
        await session.unload();
        await this.refreshAccounts();
        return this.processInfo(session);
    }

    async refreshProcess(pid: number): Promise<HookProcessInfo> {
        this.assertValidPid(pid);
        await this.startPromise;
        const session = this.ensureSession(pid);
        await session.refresh();
        await this.refreshAccounts();
        return this.processInfo(session);
    }

    dispose(): void {
        if (this.disposed) {
            return;
        }

        this.disposed = true;

        for (const session of this.sessions.values()) {
            session.dispose();
        }

        this.sessions.clear();
        this.accounts.clear();
        this.autoLoadAttempts.clear();
        this.enumerator?.dispose();

        if (this.ownsPipeWatcher) {
            this.pipeWatcher.dispose();
        }
    }

    // ─────────────── wiring ───────────────

    private processInfo(session: HookSession): HookProcessInfo {
        return { ...session.toInfo(), account: this.accounts.get(session.pid) ?? null };
    }

    /** REST, watcher ticks and login reconciliation share the same account snapshot. */
    private async refreshAccounts(): Promise<void> {
        if (this.disposed) {
            return;
        }

        if (this.accountProbe) {
            await this.accountProbe;

            // Process discovery invalidates the snapshot while a read is in flight.
            if (this.nextAccountProbeAt === 0) {
                await this.refreshAccounts();
            }

            return;
        }

        if (Date.now() < this.nextAccountProbeAt || this.sessions.size === 0) {
            return;
        }

        this.nextAccountProbeAt = Date.now() + this.accountReprobeIntervalMs;
        this.accountProbe = runWithTraceRequest(() => this.readAccounts()).finally(() => {
            this.accountProbe = null;
        });
        await this.accountProbe;
    }

    private async readAccounts(): Promise<void> {
        const sessions = new Map(this.sessions);
        const accounts = new Map<number, HookProcessAccount>();

        try {
            for (const state of await this.detectAccounts([...sessions.keys()])) {
                if (
                    state.pid !== null &&
                    sessions.has(state.pid) &&
                    this.sessions.get(state.pid) === sessions.get(state.pid)
                ) {
                    accounts.set(state.pid, { uin: state.uin, nickname: state.nickname });
                }
            }

            this.lastAccountProbeFailure = '';
        } catch (error) {
            const message = errMsg(error);

            if (this.lastAccountProbeFailure !== message) {
                this.lastAccountProbeFailure = message;
                this.log.warn('account detection failed: %s', message);
            }
        }

        if (this.disposed) {
            return;
        }

        const changed =
            accounts.size !== this.accounts.size ||
            [...accounts].some(([pid, account]) => {
                const previous = this.accounts.get(pid);
                return previous?.uin !== account.uin || previous.nickname !== account.nickname;
            });
        this.accounts = accounts;

        if (changed) {
            this.notifySessionsChanged();
        }
    }

    private bindWatcher(): void {
        this.pipeWatcher.on('process-discovered', (info: HookProcessBaseInfo) => {
            if (this.disposed) {
                return;
            }

            runWithTraceRequest(() => {
                const session = this.ensureSession(info.pid);
                session.attachProcessInfo(info);
                this.log.trace(() => [
                    'hook_manager_fact event=process_discovered pid=%d info=%s autoLoad=%s',
                    info.pid,
                    renderParamsVerbose(info),
                    this.autoLoadOnDiscovery,
                ]);

                // Headless/Docker deployments enable autoLoadOnDiscovery so QQ gets
                // injected without a human clicking "Load" in WebUI. Fire-and-forget:
                // failures are already captured inside loadInternal and surfaced via
                // the session's status field.
                if (this.autoLoadOnDiscovery && shouldAutoLoadPid(info.pid, this.log)) {
                    this.runAutoLoad(session);
                }

                this.notifySessionsChanged();
            });
        });
        this.pipeWatcher.on('process-gone', (pid: number) => {
            if (this.disposed) {
                return;
            }

            runWithTraceRequest(() => {
                this.autoLoadAttempts.delete(pid);
                const session = this.sessions.get(pid);
                this.log.trace(
                    'hook_manager_fact event=process_gone pid=%d tracked=%s',
                    pid,
                    session !== undefined,
                );

                if (session) {
                    session.notifyProcessGone();
                }

                this.notifySessionsChanged();
            });
        });
        this.pipeWatcher.on('pipe-up', (pid: number) => {
            if (this.disposed) {
                return;
            }

            const session = this.sessions.get(pid);

            if (session) {
                session.onPipeUp();
            }
        });
        this.pipeWatcher.on('pipe-down', (pid: number) => {
            if (this.disposed) {
                return;
            }

            const session = this.sessions.get(pid);

            if (session) {
                session.onPipeDown();
            }
        });
        // After every tick, retry sessions that are stuck in 'connecting' OR
        // 'disconnected' while the pipe is up. Mirrors the original
        // tickWatcher's per-tick reconcileConnect pass; onPipeUp is idempotent
        // so calling it for an already-connected session is harmless.
        //
        // The 'disconnected' branch matters on Windows: when the QQ-NT side of
        // the named pipe stays alive but the SnowLuma-side socket dies (read
        // EPIPE / idle-timeout / similar transient I/O fault), the watcher
        // sees the pipe as still-live (the OS-level pipe is still listed by
        // `listLivePipes`) so it never fires another `pipe-up`. Without
        // retrying 'disconnected' sessions here the session is stranded
        // forever — a real-world symptom users reported as "Windows running
        // for a while then stops" with logs `pipe error: read EPIPE` →
        // `session closed: UIN=…`.
        this.pipeWatcher.on('tick', () => {
            if (this.disposed) {
                return;
            }

            void this.refreshAccounts();

            for (const session of this.sessions.values()) {
                const autoLoad = this.autoLoadAttempts.get(session.pid);

                if (
                    autoLoad &&
                    !autoLoad.inFlight &&
                    session.status === 'error' &&
                    isTransientLibcMappingError(session.error)
                ) {
                    this.runAutoLoad(session, autoLoad);
                    continue;
                }

                if (
                    (session.status === 'connecting' ||
                        session.status === 'disconnected' ||
                        session.status === 'error') &&
                    this.pipeWatcher.isPipeLive(session.pid)
                ) {
                    session.onPipeUp();
                }
            }
        });
    }

    private runAutoLoad(session: HookSession, existing?: AutoLoadAttempt): void {
        if (this.disposed || session.isDisposed) {
            return;
        }

        const state = existing ?? { attempts: 0, inFlight: false };

        if (state.inFlight || state.attempts >= AUTO_LOAD_MAX_ATTEMPTS) {
            return;
        }

        state.attempts += 1;
        state.inFlight = true;
        this.autoLoadAttempts.set(session.pid, state);
        const attempt = state.attempts;

        void runWithTraceRequest(async () => {
            const startedAt = Date.now();
            this.log.trace(
                'hook_autoload_start pid=%d attempt=%d maxAttempts=%d',
                session.pid,
                attempt,
                AUTO_LOAD_MAX_ATTEMPTS,
            );

            try {
                const info = await session.load();

                if (this.autoLoadAttempts.get(session.pid) !== state) {
                    this.log.trace(
                        'hook_autoload_terminal pid=%d attempt=%d outcome=dropped reason=superseded elapsedMs=%d',
                        session.pid,
                        attempt,
                        Date.now() - startedAt,
                    );
                    return;
                }

                state.inFlight = false;

                if (info.status !== 'error') {
                    this.autoLoadAttempts.delete(session.pid);
                    const reason = attempt > 1 ? 'recovered' : 'loaded';
                    this.log.trace(() => [
                        'hook_autoload_terminal pid=%d attempt=%d outcome=completed reason=%s state=%s elapsedMs=%d',
                        session.pid,
                        attempt,
                        reason,
                        renderParamsVerbose(info),
                        Date.now() - startedAt,
                    ]);

                    if (attempt > 1) {
                        this.log.info(
                            'auto-load recovered: PID=%d attempt=%d/%d',
                            session.pid,
                            attempt,
                            AUTO_LOAD_MAX_ATTEMPTS,
                        );
                    }

                    return;
                }

                if (!isTransientLibcMappingError(info.error)) {
                    this.autoLoadAttempts.delete(session.pid);
                    this.log.trace(
                        'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=permanent_failure error=%j elapsedMs=%d',
                        session.pid,
                        attempt,
                        info.error,
                        Date.now() - startedAt,
                    );
                    return;
                }

                if (attempt >= AUTO_LOAD_MAX_ATTEMPTS) {
                    this.autoLoadAttempts.delete(session.pid);
                    this.log.trace(
                        'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=retry_exhausted error=%j elapsedMs=%d',
                        session.pid,
                        attempt,
                        info.error,
                        Date.now() - startedAt,
                    );
                    this.log.warn(
                        'auto-load retry exhausted: PID=%d attempts=%d err=%s',
                        session.pid,
                        attempt,
                        info.error,
                    );
                    return;
                }

                this.log.trace(
                    'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=retry_pending error=%j elapsedMs=%d',
                    session.pid,
                    attempt,
                    info.error,
                    Date.now() - startedAt,
                );
                this.log.warn(
                    'auto-load retry pending: PID=%d attempt=%d/%d err=%s',
                    session.pid,
                    attempt,
                    AUTO_LOAD_MAX_ATTEMPTS,
                    info.error,
                );
            } catch (err) {
                if (this.autoLoadAttempts.get(session.pid) === state) {
                    this.autoLoadAttempts.delete(session.pid);
                }

                this.log.trace(
                    'hook_autoload_terminal pid=%d attempt=%d outcome=failed reason=unexpected_failure error=%j elapsedMs=%d',
                    session.pid,
                    attempt,
                    errMsg(err),
                    Date.now() - startedAt,
                );
                this.log.warn('auto-load failed: PID=%d err=%s', session.pid, errMsg(err));
            }
        });
    }

    private ensureSession(pid: number): HookSession {
        let session = this.sessions.get(pid);

        if (session) {
            return session;
        }

        session = new HookSession(pid, {
            injector: this.injector,
            makeClient: this.makeClient,
            pipeWatcher: this.pipeWatcher,
            onPacket: this.onPacket,
            detectLoginUin: async () => {
                await this.refreshAccounts();
                return this.accounts.get(pid)?.uin ?? null;
            },
            log: this.log,
        });
        session.attachProcessInfo({ name: defaultProcessName() });

        session.on('login', (uin: string, sender) => {
            this.bridgeManager.onHookLogin(pid, uin, sender);
        });
        session.on('disconnected', (wasLoggedIn: boolean) => {
            if (wasLoggedIn) {
                this.bridgeManager.onPidDisconnected(pid);
            }
        });
        session.on('receive-health-changed', (healthy: boolean) => {
            this.bridgeManager.onPidReceiveHealthChanged(pid, healthy);
        });
        // status-changed fires on EVERY internal status mutation, including the
        // ones reached via login / disconnected / refresh — subscribing here
        // alone covers every transition the WebUI processes view cares about.
        session.on('status-changed', () => {
            this.notifySessionsChanged();
        });
        session.on('disposed', () => {
            this.sessions.delete(pid);
            this.accounts.delete(pid);
            this.nextAccountProbeAt = 0;
        });

        this.sessions.set(pid, session);
        this.nextAccountProbeAt = 0;
        return session;
    }

    /** Fire the optional sessions-changed hook with exceptions isolated.
     * A throwing subscriber must not abort the watcher's emit loop or break
     * a HookSession event handler in flight. */
    private notifySessionsChanged(): void {
        if (this.disposed) {
            return;
        }

        if (!this.onSessionsChangedRaw) {
            return;
        }

        try {
            this.onSessionsChangedRaw();
        } catch (err) {
            this.log.warn('onSessionsChanged threw: %s', errMsg(err));
        }
    }

    private assertValidPid(pid: number): void {
        if (!Number.isInteger(pid) || pid <= 0) {
            throw new Error('invalid pid');
        }
    }
}

function defaultProcessName(): string {
    return process.platform === 'win32' ? 'QQ.exe' : 'qq';
}

function errMsg(value: unknown): string {
    return value instanceof Error ? value.message : String(value);
}

function isTransientLibcMappingError(error: string): boolean {
    return /^target process does not map \S*\/libc\.so\.6 while resolving mmap$/.test(error);
}

/**
 * Filter for auto-load only. Returns false for Linux Electron child
 * processes (zygote/renderer/gpu/utility), which the native enumerator
 * mis-classifies as "main QQ" because their cmdline contains "qq" and
 * they transiently inherit wrapper.node via fork copy-on-write.
 *
 * Injecting into a zygote spawns the hook's resolver thread inside it;
 * every renderer Electron later forks then inherits that thread + the
 * partially-init'd hook state, which breaks QQ's IPC and login UI.
 *
 * Manual loadProcess() bypasses this gate — the operator is responsible
 * for picking the right PID from WebUI.
 */
export function shouldAutoLoadPid(pid: number, log: Logger): boolean {
    if (process.platform !== 'linux') {
        return true;
    }

    // Escape hatch: operators who explicitly want auto-load on every
    // enumerated PID can set this to opt out of the filter.
    if (process.env.SNOWLUMA_HOOK_AUTOLOAD_ALL === '1') {
        return true;
    }

    let cmdline: string;

    try {
        cmdline = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8');
    } catch {
        // Can't read cmdline (process gone, permission, etc.) — let the
        // existing load() path handle it; if the process is dead the load
        // will fail with a clear error.
        return true;
    }

    if (cmdline.includes('--type=')) {
        const type = /--type=([^\0\s]+)/.exec(cmdline)?.[1] ?? 'unknown';
        log.info('auto-load skip: PID=%d is an Electron child process (--type=%s)', pid, type);
        return false;
    }

    return true;
}

export type { HookProcessBaseInfo } from './injector';
export type { HookProcessAccount, HookProcessInfo, HookProcessStatus } from './types';
