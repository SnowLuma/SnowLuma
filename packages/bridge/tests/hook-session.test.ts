import { afterEach, describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HookSession } from '../src/hook-session';
import type { ManualMapHandle } from '../src/injector';
import type { QqHookClient, QqHookPacket } from '../src/qq-hook-client';
import type { QqPortLoginInfo } from '../src/qq-port-probe';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketSink } from '@snowluma/common/protocol-types';
import {
  getLogLevel,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';

const previousLogLevel = getLogLevel();

function sessionTrace(entries: LogEntry[]): LogEntry[] {
  return entries.filter(
    (entry) => entry.level === 'trace' && entry.scope === 'HookSession',
  );
}

afterEach(() => {
  setLogLevel(previousLogLevel);
});

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };

/** Minimal stand-in for QqHookClient. Tests drive login/packet/error/close
 * events directly via fire* helpers. connectAll succeeds unless told otherwise. */
class FakeClient extends EventEmitter {
  isClosed = false;
  isLoggedIn = false;
  shouldFailConnect = false;
  readonly sentPackets: Array<{ serviceCmd: string; body: Buffer }> = [];
  private loginState = { loggedIn: false, uin: '0', uinNumber: 0n };

  async connectAll(_opts: { recv: boolean }): Promise<void> {
    if (this.shouldFailConnect) throw new Error('connect failed');
    if (this.isClosed) throw new Error('client is closed');
  }
  getLoginState() { return { ...this.loginState }; }
  reconcileLoginState(state: { loggedIn: boolean; uin: string; uinNumber: bigint }): void {
    this.isLoggedIn = state.loggedIn;
    this.loginState = { ...state };
    this.emit('loginState', { ...this.loginState });
  }
  async send(serviceCmd: string, body: Buffer) {
    this.sentPackets.push({ serviceCmd, body: Buffer.from(body) });
    return {
      requestId: this.sentPackets.length,
      error: 0,
      message: '',
      body: Buffer.from('reply'),
    };
  }
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close');
  }

  fireLogin(uin: string): void {
    this.reconcileLoginState({ loggedIn: true, uin, uinNumber: BigInt(uin) });
  }

  firePacket(packet: QqHookPacket): void {
    this.emit('packet', packet);
  }
}

function makeSession(opts: {
  pid?: number;
  pipeLive?: boolean;
  clientFailsConnect?: boolean;
  onPacket?: PacketSink;
  probeLogin?: (pid: number) => Promise<QqPortLoginInfo | null>;
} = {}) {
  const pid = opts.pid ?? 1234;
  let pipeLive = opts.pipeLive ?? false;
  const clients: FakeClient[] = [];
  const injector = {
    inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
    unload: vi.fn(),
  };
  // Default probe reports "not logged in" so the reconcile safety net is inert
  // unless a test opts into a logged-in probe (never hits the real port scan).
  const probeLogin = opts.probeLogin ?? (async () => ({ port: 0, uin: '', loggedIn: false }));

  const session = new HookSession(pid, {
    injector,
    makeClient: () => {
      const c = new FakeClient();
      if (opts.clientFailsConnect) c.shouldFailConnect = true;
      clients.push(c);
      // Cast: FakeClient mirrors only the surface HookSession touches.
      return c as unknown as QqHookClient;
    },
    probeLogin,
    pipeWatcher: { isPipeLive: () => pipeLive },
    onPacket: opts.onPacket,
  });

  return {
    session,
    injector,
    clients,
    currentClient: () => clients[clients.length - 1]!,
    setPipeLive: (v: boolean) => { pipeLive = v; },
  };
}

const flush = () => new Promise<void>(r => setImmediate(r));

describe('HookSession — runtime TRACE', () => {
  it('records injection and existing-pipe load branches with unique terminals', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const injected = makeSession({ pid: 7101, pipeLive: false });
      const reconnect = makeSession({ pid: 7102, pipeLive: true });
      await injected.session.load();
      await reconnect.session.load();

      const messages = sessionTrace(entries).map((entry) => entry.message);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringContaining('hook_session_start pid=7101 operation=load'),
        'hook_session_branch pid=7101 operation=load branch=inject_begin',
        'hook_session_branch pid=7101 operation=load branch=inject_completed method="loadModuleManual"',
        expect.stringMatching(/^hook_session_terminal pid=7101 operation=load outcome=completed reason=load_settled state=.*elapsedMs=\d+$/),
        expect.stringContaining('hook_session_start pid=7102 operation=load'),
        'hook_session_branch pid=7102 operation=load branch=existing_pipe method="reconnect"',
        expect.stringMatching(/^hook_session_terminal pid=7102 operation=load outcome=completed reason=load_settled state=.*elapsedMs=\d+$/),
      ]));
      for (const pid of [7101, 7102]) {
        expect(messages.filter(
          (message) => message.startsWith(`hook_session_terminal pid=${pid} operation=load `),
        )).toHaveLength(1);
      }
    } finally {
      unsubscribe();
    }
  });

  it('records load and connection failures with truthful settled state', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      const injector = {
        inject: vi.fn(() => { throw new Error('fixture inject failure'); }),
        unload: vi.fn(),
      };
      const failedLoad = new HookSession(7103, {
        injector,
        makeClient: () => new FakeClient() as unknown as QqHookClient,
        pipeWatcher: { isPipeLive: () => false },
      });
      await failedLoad.load();

      const failedConnect = makeSession({
        pid: 7104,
        pipeLive: true,
        clientFailsConnect: true,
      });
      await failedConnect.session.load();
      failedConnect.session.onPipeUp();
      await flush();

      const messages = sessionTrace(entries).map((entry) => entry.message);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringMatching(/^hook_session_terminal pid=7103 operation=load outcome=failed reason=load_failed error="fixture inject failure" state=.*elapsedMs=\d+$/),
        expect.stringContaining('hook_session_connect_start pid=7104'),
        expect.stringMatching(/^hook_session_connect_terminal pid=7104 outcome=failed reason=connect_failed error="connect failed" state=.*elapsedMs=\d+$/),
      ]));
      expect(messages.filter(
        (message) => message.startsWith('hook_session_connect_terminal pid=7104 '),
      )).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('records login, disconnect, and process-gone only when state changes', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const ctx = makeSession({ pid: 7105, pipeLive: true });
    try {
      await ctx.session.load();
      ctx.session.onPipeUp();
      await flush();
      ctx.currentClient().fireLogin('10001');
      ctx.currentClient().fireLogin('10001');
      ctx.session.onPipeDown();
      await flush();
      ctx.session.onPipeDown();
      await flush();
      ctx.session.notifyProcessGone();
      await flush();

      const messages = sessionTrace(entries).map((entry) => entry.message);
      expect(messages.filter(
        (message) => message.startsWith('hook_session_login_terminal pid=7105 '),
      )).toHaveLength(1);
      expect(messages.filter(
        (message) => message.startsWith('hook_session_disconnect_terminal pid=7105 '),
      )).toHaveLength(1);
      expect(messages.filter(
        (message) => message.startsWith('hook_session_process_terminal pid=7105 '),
      )).toHaveLength(1);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringMatching(/^hook_session_login_terminal pid=7105 outcome=completed reason=login_detected previousUin="0" uin="10001" state=.*elapsedMs=\d+$/),
        expect.stringMatching(/^hook_session_disconnect_terminal pid=7105 outcome=completed reason=pipe_down wasLoggedIn=true state=.*elapsedMs=\d+$/),
        expect.stringMatching(/^hook_session_process_terminal pid=7105 outcome=completed reason=process_gone wasLoggedIn=false state=.*elapsedMs=\d+$/),
      ]));
    } finally {
      unsubscribe();
      ctx.session.dispose();
    }
  });

  it('records failed terminals when lifecycle listeners throw', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const login = makeSession({ pid: 7107, pipeLive: true });
    const disconnect = makeSession({ pid: 7108, pipeLive: true });
    const processGone = makeSession({ pid: 7109, pipeLive: true });
    try {
      await login.session.load();
      login.session.onPipeUp();
      await flush();
      login.session.on('login', () => { throw new Error('login listener boom'); });
      expect(() => login.currentClient().fireLogin('10001')).toThrow('login listener boom');

      await disconnect.session.load();
      disconnect.session.onPipeUp();
      await flush();
      disconnect.currentClient().fireLogin('10002');
      disconnect.session.on('disconnected', () => { throw new Error('disconnect listener boom'); });
      disconnect.session.onPipeDown();
      await flush();

      processGone.session.on('disposed', () => { throw new Error('dispose listener boom'); });
      processGone.session.notifyProcessGone();
      await flush();

      const messages = sessionTrace(entries).map((entry) => entry.message);
      expect(messages.filter((message) =>
        message.startsWith('hook_session_login_terminal pid=7107 '))).toEqual([
        expect.stringMatching(/^hook_session_login_terminal pid=7107 outcome=failed reason=listener_failed error="login listener boom" state=.*elapsedMs=\d+$/),
      ]);
      expect(messages.filter((message) =>
        message.startsWith('hook_session_disconnect_terminal pid=7108 '))).toEqual([
        expect.stringMatching(/^hook_session_disconnect_terminal pid=7108 outcome=failed reason=listener_failed error="disconnect listener boom" state=.*elapsedMs=\d+$/),
      ]);
      expect(messages.filter((message) =>
        message.startsWith('hook_session_process_terminal pid=7109 '))).toEqual([
        expect.stringMatching(/^hook_session_process_terminal pid=7109 outcome=failed reason=listener_failed error="dispose listener boom" state=.*elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
      login.session.dispose();
      disconnect.session.dispose();
      processGone.session.dispose();
    }
  });

  it('records unload verification failure as a failed terminal', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const ctx = makeSession({ pid: 7106, pipeLive: false });
    try {
      await ctx.session.load();
      ctx.setPipeLive(true);
      await ctx.session.unload();

      const terminals = sessionTrace(entries).filter(
        (entry) => entry.message.startsWith('hook_session_terminal pid=7106 operation=unload '),
      );
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.message).toMatch(
        /^hook_session_terminal pid=7106 operation=unload outcome=failed reason=unload_verification_failed error=.*state=.*elapsedMs=\d+$/,
      );
    } finally {
      unsubscribe();
    }
  });
});

describe('HookSession — load', () => {
  it('with no live pipe: injects, status → connecting, method from inject result', async () => {
    const { session, injector } = makeSession({ pipeLive: false });
    const info = await session.load();

    expect(injector.inject).toHaveBeenCalledOnce();
    expect(info.status).toBe('connecting');
    expect(info.method).toBe('loadModuleManual');
    expect(info.injected).toBe(true);
  });

  it('fast-path: pipe already live → skip inject, method → "reconnect"', async () => {
    const { session, injector } = makeSession({ pipeLive: true });
    const info = await session.load();

    expect(injector.inject).not.toHaveBeenCalled();
    expect(info.method).toBe('reconnect');
    expect(info.injected).toBe(true);
    expect(info.status).toBe('connecting');
  });

  it('keeps loading pending until asynchronous component loading completes', async () => {
    let finishLoading!: (result: { method: 'loadModuleManual'; handle: ManualMapHandle }) => void;
    const loading = new Promise<{ method: 'loadModuleManual'; handle: ManualMapHandle }>(resolve => {
      finishLoading = resolve;
    });
    const injector = {
      inject: vi.fn(() => loading),
      unload: vi.fn(),
    };
    const session = new HookSession(1234, {
      injector,
      makeClient: () => new FakeClient() as unknown as QqHookClient,
      pipeWatcher: { isPipeLive: () => false },
    });

    const load = session.load();
    await flush();

    expect(session.status).toBe('loading');
    finishLoading({ method: 'loadModuleManual', handle: DUMMY_HANDLE });
    await expect(load).resolves.toMatchObject({
      status: 'connecting',
      method: 'loadModuleManual',
      injected: true,
    });
  });

  it('inject failure → status error, error message captured', async () => {
    const injector = {
      inject: vi.fn(() => { throw new Error('inject boom'); }),
      unload: vi.fn(),
    };
    const session = new HookSession(1234, {
      injector,
      makeClient: () => new FakeClient() as unknown as QqHookClient,
      pipeWatcher: { isPipeLive: () => false },
    });
    const info = await session.load();
    expect(info.status).toBe('error');
    expect(info.error).toBe('inject boom');
  });

  it('can retry after asynchronous component loading fails', async () => {
    const injector = {
      inject: vi
        .fn()
        .mockRejectedValueOnce(new Error('component loading timed out'))
        .mockResolvedValueOnce({
          method: 'loadModuleManual' as const,
          handle: DUMMY_HANDLE,
        }),
      unload: vi.fn(),
    };
    const session = new HookSession(1234, {
      injector,
      makeClient: () => new FakeClient() as unknown as QqHookClient,
      pipeWatcher: { isPipeLive: () => false },
    });

    await expect(session.load()).resolves.toMatchObject({
      status: 'error',
      error: 'component loading timed out',
      injected: false,
    });
    await expect(session.load()).resolves.toMatchObject({
      status: 'connecting',
      method: 'loadModuleManual',
      injected: true,
      error: '',
    });
    expect(injector.inject).toHaveBeenCalledTimes(2);
  });
});

describe('HookSession — pipe up/down → connect lifecycle', () => {
  it('onPipeUp after load: client connects → status loaded', async () => {
    const ctx = makeSession({ pipeLive: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();

    expect(ctx.session.status).toBe('loaded');
    expect(ctx.clients).toHaveLength(1);
  });

  it('emits "login" with (uin, sender) after client signals loggedIn', async () => {
    const ctx = makeSession({ pipeLive: true });
    const loginSpy = vi.fn();
    ctx.session.on('login', loginSpy);

    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    expect(loginSpy).toHaveBeenCalledOnce();
    const [uin, sender] = loginSpy.mock.calls[0]!;
    expect(uin).toBe('10001');
    expect(typeof (sender as { sendPacket: unknown }).sendPacket).toBe('function');
    expect(ctx.session.status).toBe('online');
    expect(ctx.session.uin).toBe('10001');
  });

  it('does not re-emit "login" on duplicate loginState with same uin', async () => {
    const ctx = makeSession({ pipeLive: true });
    const loginSpy = vi.fn();
    ctx.session.on('login', loginSpy);

    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();

    ctx.currentClient().fireLogin('10001');
    ctx.currentClient().fireLogin('10001');

    expect(loginSpy).toHaveBeenCalledOnce();
  });

  it('connect failure: stays in connecting, error message captured (will retry on next tick)', async () => {
    const ctx = makeSession({ pipeLive: true, clientFailsConnect: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();

    expect(ctx.session.status).toBe('connecting');
    expect(ctx.session.error).toBe('connect failed');
  });

  it('onPipeDown while logged in: emits disconnected(true), status disconnected', async () => {
    const ctx = makeSession({ pipeLive: true });
    const discSpy = vi.fn();
    ctx.session.on('disconnected', discSpy);

    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    ctx.session.onPipeDown();
    await flush();

    expect(discSpy).toHaveBeenCalledWith(true);
    expect(ctx.session.status).toBe('disconnected');
  });

  it('onPipeDown while connected-but-not-logged-in: emits disconnected(false), status connecting', async () => {
    const ctx = makeSession({ pipeLive: true });
    const discSpy = vi.fn();
    ctx.session.on('disconnected', discSpy);

    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    // No login fired — we're connected but not logged in.

    ctx.session.onPipeDown();
    await flush();

    // disconnected(false) is currently NOT emitted — disconnect events are
    // reserved for "we owe BridgeManager a disconnect notification". This
    // preserves the original behaviour.
    expect(discSpy).not.toHaveBeenCalled();
    expect(ctx.session.status).toBe('connecting');
  });

  it('repeated pipe down → up cycles reach consistent state', async () => {
    const ctx = makeSession({ pipeLive: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');
    expect(ctx.session.status).toBe('online');

    ctx.session.onPipeDown();
    await flush();
    expect(ctx.session.status).toBe('disconnected');

    // Pipe returns — session builds a fresh client.
    ctx.session.onPipeUp();
    await flush();
    expect(ctx.clients.length).toBeGreaterThan(1);
    expect(ctx.session.status).toBe('loaded');
  });
});

describe('HookSession — unload', () => {
  it('while logged in: emits disconnected(true), calls unload, status available', async () => {
    const ctx = makeSession({ pipeLive: false });
    await ctx.session.load();
    ctx.setPipeLive(true);
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    const discSpy = vi.fn();
    ctx.session.on('disconnected', discSpy);
    ctx.setPipeLive(false); // unload verification will see the pipe gone

    await ctx.session.unload();

    expect(discSpy).toHaveBeenCalledWith(true);
    expect(ctx.injector.unload).toHaveBeenCalledOnce();
    expect(ctx.session.status).toBe('available');
  });

  it('when pipe stays live after unload: status connecting with retry message', async () => {
    const ctx = makeSession({ pipeLive: false });
    await ctx.session.load();
    // Simulate the unload-failed scenario: pipe is still up after unload.
    ctx.setPipeLive(true);

    const info = await ctx.session.unload();

    expect(info.status).toBe('connecting');
    expect(info.error).toContain('命名管道仍然存在');
  });

  it('forces a fresh tick before verifying so a stale snapshot does not false-flag a successful unload', async () => {
    // Reproduces the Windows-WebUI bug: PipeWatcher's cached snapshot is
    // up to 1500ms stale, so right after a successful native unload the
    // pre-fix code would read isPipeLive() == true and report failure
    // even though the DLL is gone. With the fix, tickNow() refreshes
    // the snapshot first and verification correctly sees the pipe down.
    const pid = 5555;
    let pipeLive = true; // initial cached state: pipe is live
    const tickNow = vi.fn(async () => { pipeLive = false; }); // OS poll says: gone now

    const session = new HookSession(pid, {
      injector: {
        inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
        unload: vi.fn(),
      },
      makeClient: () => new FakeClient() as unknown as QqHookClient,
      pipeWatcher: { isPipeLive: () => pipeLive, tickNow },
    });
    await session.load();
    pipeLive = true; // ensure the pre-check snapshot says "live"

    const info = await session.unload();

    expect(tickNow).toHaveBeenCalledOnce();
    expect(info.status).toBe('available');
    expect(info.error).toBe('');
  });
});

describe('HookSession — serialization', () => {
  it('user mashing load → unload → load runs in order, end state consistent', async () => {
    const ctx = makeSession({ pipeLive: false });

    const p1 = ctx.session.load();
    const p2 = ctx.session.unload();
    const p3 = ctx.session.load();
    await Promise.all([p1, p2, p3]);

    expect(ctx.injector.inject).toHaveBeenCalledTimes(2);
    expect(ctx.injector.unload).toHaveBeenCalledTimes(1);
    expect(ctx.session.status).toBe('connecting');
  });

  it('onPipeUp queued behind in-flight load resolves correctly', async () => {
    const ctx = makeSession({ pipeLive: true });

    const loadPromise = ctx.session.load();
    ctx.session.onPipeUp(); // queued behind load

    await loadPromise;
    await flush();

    expect(ctx.session.status).toBe('loaded');
  });
});

describe('HookSession — process gone', () => {
  it('emits disconnected(true) then disposed when killed while logged in', async () => {
    const ctx = makeSession({ pipeLive: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    const events: string[] = [];
    ctx.session.on('disconnected', () => events.push('disconnected'));
    ctx.session.on('disposed', () => events.push('disposed'));

    ctx.session.notifyProcessGone();
    await flush();

    expect(events).toEqual(['disconnected', 'disposed']);
    expect(ctx.session.isDisposed).toBe(true);
  });

  it('emits only disposed when killed before login', async () => {
    const ctx = makeSession({ pipeLive: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();

    const events: string[] = [];
    ctx.session.on('disconnected', () => events.push('disconnected'));
    ctx.session.on('disposed', () => events.push('disposed'));

    ctx.session.notifyProcessGone();
    await flush();

    expect(events).toEqual(['disposed']);
  });
});

describe('HookSession — refresh drift fix', () => {
  // refresh while the pipe is down on a connected-but-never-logged-in
  // session now reports 'connecting' (matching what onPipeDown gives for the
  // same state), not the old spurious 'disconnected'. Pre-refactor, refresh's
  // down branch ignored wasLoggedIn and always reported 'disconnected'.

  it('refresh-while-down + never logged in → connecting (not disconnected), no disconnect emit', async () => {
    const ctx = makeSession({ pipeLive: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    expect(ctx.session.status).toBe('loaded'); // connected, never logged in

    const discSpy = vi.fn();
    ctx.session.on('disconnected', discSpy);
    ctx.setPipeLive(false);

    const info = await ctx.session.refresh();

    expect(info.status).toBe('connecting');     // drift fix: was 'disconnected'
    expect(discSpy).not.toHaveBeenCalled();      // never logged in ⇒ nothing owed
  });

  it('refresh-while-down after login still → disconnected + emits disconnected(true)', async () => {
    // The flip is scoped to the never-logged-in case; a real session that
    // had reached login must still settle to 'disconnected' and notify.
    const ctx = makeSession({ pipeLive: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');
    expect(ctx.session.status).toBe('online');

    const discSpy = vi.fn();
    ctx.session.on('disconnected', discSpy);
    ctx.setPipeLive(false);

    const info = await ctx.session.refresh();

    expect(info.status).toBe('disconnected');
    expect(discSpy).toHaveBeenCalledWith(true);
  });
});

describe('HookSession — pipe-down must not clobber a settled error', () => {
  // Regression net for the phase-2 reconcilePipeDown !connected short-circuit:
  // a pipe-down tick on a session that never reached a live connection must
  // not wipe a diagnostic error or emit a spurious status-changed.

  it('onPipeDown after a failed connect keeps the error and does not re-emit', async () => {
    const ctx = makeSession({ pipeLive: true, clientFailsConnect: true });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    expect(ctx.session.status).toBe('connecting');
    expect(ctx.session.error).toBe('connect failed');

    const statusSpy = vi.fn();
    ctx.session.on('status-changed', statusSpy);
    ctx.session.onPipeDown();
    await flush();

    expect(ctx.session.status).toBe('connecting');
    expect(ctx.session.error).toBe('connect failed'); // not wiped to ''
    expect(statusSpy).not.toHaveBeenCalled();          // no spurious emit
  });

  it('onPipeDown after a failed load leaves the error status intact', async () => {
    const injector = {
      inject: vi.fn(() => { throw new Error('inject boom'); }),
      unload: vi.fn(),
    };
    const session = new HookSession(1234, {
      injector,
      makeClient: () => new FakeClient() as unknown as QqHookClient,
      pipeWatcher: { isPipeLive: () => false },
    });
    await session.load();
    expect(session.status).toBe('error');
    expect(session.error).toBe('inject boom');

    session.onPipeDown();
    await flush();

    expect(session.status).toBe('error');      // not flipped to 'available'
    expect(session.error).toBe('inject boom');  // not wiped
  });
});

describe('HookSession — packet forwarding', () => {
  // These tests cover the field-rename + filter logic that used to live
  // inside the deleted NtqqHandler.onHookPacket. Inlining it here means
  // we can exercise the transformation with a plain vi.fn() sink, no
  // event-emitter machinery required.

  it('forwards parsed packets to onPacket sink with PacketInfo shape', async () => {
    const onPacket = vi.fn();
    const ctx = makeSession({ pipeLive: true, onPacket });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    ctx.currentClient().firePacket({
      seq: 42,
      error: 0,
      cmd: 'trpc.msg.olpush.OlPushService.MsgPush',
      uin: '10001',
      body: Buffer.from([0x01, 0x02, 0x03]),
    });

    expect(onPacket).toHaveBeenCalledOnce();
    const pkt = onPacket.mock.calls[0]![0];
    expect(pkt).toMatchObject({
      pid: 1234,
      uin: '10001',
      serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
      seqId: 42,
      retCode: 0,
      fromClient: false,
    });
    expect(Buffer.isBuffer(pkt.body)).toBe(true);
    expect([...pkt.body]).toEqual([1, 2, 3]);
  });

  it('falls back to session uin when packet.uin is empty', async () => {
    const onPacket = vi.fn();
    const ctx = makeSession({ pipeLive: true, onPacket });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    ctx.currentClient().firePacket({
      seq: 1, error: 0, cmd: 'foo', uin: '', body: Buffer.alloc(0),
    });

    expect(onPacket.mock.calls[0]![0].uin).toBe('10001');
  });

  it('drops packets received before login', async () => {
    const onPacket = vi.fn();
    const ctx = makeSession({ pipeLive: true, onPacket });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    // No login fired yet.

    ctx.currentClient().firePacket({
      seq: 1, error: 0, cmd: 'foo', uin: '10001', body: Buffer.alloc(0),
    });

    expect(onPacket).not.toHaveBeenCalled();
  });

  it('drops packets whose uin is non-real ("0" / too short / non-numeric)', async () => {
    const onPacket = vi.fn();
    const ctx = makeSession({ pipeLive: true, onPacket });
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    // Packet uin '0' falls back to session uin '10001' — that one passes.
    // Force a bad uin via the packet AND null out session uin by simulating
    // a logout? Simpler: send a packet with uin '42' (numeric but <5 chars).
    ctx.currentClient().firePacket({
      seq: 1, error: 0, cmd: 'foo', uin: '42', body: Buffer.alloc(0),
    });

    expect(onPacket).not.toHaveBeenCalled();
  });

  it('is a no-op when no onPacket sink is provided', async () => {
    const ctx = makeSession({ pipeLive: true });   // no onPacket
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');

    // Should not throw / crash.
    ctx.currentClient().firePacket({
      seq: 1, error: 0, cmd: 'foo', uin: '10001', body: Buffer.from([7]),
    });
  });
});

describe('HookSession — login reconcile (Docker auto-login safety net)', () => {
  it('keeps the packet sender usable when login is reconciled by the active probe', async () => {
    const ctx = makeSession({
      pipeLive: true,
      probeLogin: async () => ({ port: 4301, uin: '10001', loggedIn: true }),
    });
    let sender: PacketSender | undefined;
    ctx.session.on('login', (_uin: string, nextSender: PacketSender) => {
      sender = nextSender;
    });

    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    await flush();

    expect(sender).toBeDefined();
    const result = await sender!.sendPacket('Test.LoginReady', Buffer.from('request'));

    expect(result).toMatchObject({
      success: true,
      gotResponse: true,
      errorCode: 0,
      responseData: Buffer.from('reply'),
    });
    expect(ctx.currentClient().sentPackets).toEqual([
      { serviceCmd: 'Test.LoginReady', body: Buffer.from('request') },
    ]);
  });

  it('reconciles login via the active probe when the pushed frame is missed', async () => {
    // Probe reports logged-in; the FakeClient never fires a loginState frame
    // (the missed-edge Docker case). The immediate reconcile probe must detect
    // it and emit "login".
    const ctx = makeSession({
      pipeLive: true,
      probeLogin: async () => ({ port: 4301, uin: '10001', loggedIn: true }),
    });
    const loginSpy = vi.fn();
    ctx.session.on('login', loginSpy);

    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();   // connect (not logged in via frame) → starts reconcile
    await flush();   // immediate probe resolves → handleLoginState

    expect(loginSpy).toHaveBeenCalledOnce();
    expect(loginSpy.mock.calls[0]![0]).toBe('10001');
    expect(ctx.session.status).toBe('online');
    expect(ctx.session.uin).toBe('10001');
  });

  it('does not log in when the probe reports not-logged-in', async () => {
    const ctx = makeSession({
      pipeLive: true,
      probeLogin: async () => ({ port: 0, uin: '', loggedIn: false }),
    });
    const loginSpy = vi.fn();
    ctx.session.on('login', loginSpy);
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush(); await flush();

    expect(loginSpy).not.toHaveBeenCalled();
    expect(ctx.session.status).toBe('loaded');
  });

  it('ignores a probe with a non-real uin (0)', async () => {
    const ctx = makeSession({
      pipeLive: true,
      probeLogin: async () => ({ port: 4301, uin: '0', loggedIn: true }),
    });
    const loginSpy = vi.fn();
    ctx.session.on('login', loginSpy);
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush(); await flush();

    expect(loginSpy).not.toHaveBeenCalled();
  });

  it('tolerates a throwing probe (best-effort, no crash/login)', async () => {
    const ctx = makeSession({
      pipeLive: true,
      probeLogin: async () => { throw new Error('port scan failed'); },
    });
    const loginSpy = vi.fn();
    ctx.session.on('login', loginSpy);
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush(); await flush();

    expect(loginSpy).not.toHaveBeenCalled();
    expect(ctx.session.status).toBe('loaded');
  });

  it('detects a login that lands on a LATER interval probe', async () => {
    vi.useFakeTimers();
    try {
      let loggedIn = false;
      const ctx = makeSession({
        pipeLive: true,
        probeLogin: async () => ({ port: 4301, uin: '10001', loggedIn }),
      });
      const loginSpy = vi.fn();
      ctx.session.on('login', loginSpy);

      await ctx.session.load();
      ctx.session.onPipeUp();
      await vi.advanceTimersByTimeAsync(0);   // connect + immediate probe (not logged in yet)
      expect(loginSpy).not.toHaveBeenCalled();

      loggedIn = true;                          // QQ finishes auto-login
      await vi.advanceTimersByTimeAsync(3000);  // next interval probe picks it up

      expect(loginSpy).toHaveBeenCalledOnce();
      expect(ctx.session.status).toBe('online');
    } finally {
      vi.useRealTimers();
    }
  });

  it('does not double-emit when the pushed frame logs in first', async () => {
    // Pushed-frame login wins; a subsequent probe with the same uin must not
    // re-emit (handleLoginState dedups), and the reconcile timer is stopped.
    const probeLogin = vi.fn(async () => ({ port: 4301, uin: '10001', loggedIn: true }));
    const ctx = makeSession({ pipeLive: true, probeLogin });
    const loginSpy = vi.fn();
    ctx.session.on('login', loginSpy);

    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001'); // pushed-frame login first
    await flush();

    expect(loginSpy).toHaveBeenCalledOnce();
    expect(ctx.session.status).toBe('online');
  });
});

describe('HookSession — end-to-end receive health (#233)', () => {
  const HEARTBEAT_CMD = 'trpc.qq_new_tech.status_svc.StatusService.SsoHeartBeat';
  const MESSAGE_CMD = 'trpc.msg.olpush.OlPushService.MsgPush';

  async function startReceiveSession(onPacket?: PacketSink) {
    const ctx = makeSession({ pipeLive: true, onPacket });
    const healthChanges: boolean[] = [];
    ctx.session.on('receive-health-changed', (healthy: boolean) => healthChanges.push(healthy));
    await ctx.session.load();
    ctx.session.onPipeUp();
    await flush();
    ctx.currentClient().fireLogin('10001');
    return { ctx, healthChanges };
  }

  function firePacket(
    ctx: ReturnType<typeof makeSession>,
    cmd: string,
    uin = '10001',
    seq = 1,
  ): void {
    ctx.currentClient().firePacket({ seq, error: 0, cmd, uin, body: Buffer.alloc(0) });
  }

  it('becomes unhealthy only after an observed QQ heartbeat stays silent, then recovers on the next packet', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { ctx, healthChanges } = await startReceiveSession();

    try {
      firePacket(ctx, HEARTBEAT_CMD);

      vi.advanceTimersByTime(90_000);
      expect(ctx.session.receiveHealthy).toBe(true);

      vi.advanceTimersByTime(15_000);
      expect(ctx.session.receiveHealthy).toBe(false);
      expect(healthChanges).toEqual([false]);

      firePacket(ctx, MESSAGE_CMD, '10001', 2);

      expect(ctx.session.receiveHealthy).toBe(true);
      expect(healthChanges).toEqual([false, true]);
    } finally {
      ctx.session.dispose();
      vi.useRealTimers();
    }
  });

  it('does not arm the watchdog when this QQ session has never exposed its heartbeat', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { ctx, healthChanges } = await startReceiveSession();

    try {
      firePacket(ctx, MESSAGE_CMD);

      vi.advanceTimersByTime(10 * 60_000);

      expect(ctx.session.receiveHealthy).toBe(true);
      expect(healthChanges).toEqual([]);
    } finally {
      ctx.session.dispose();
      vi.useRealTimers();
    }
  });

  it('uses the confirmation window to avoid a sleep-resume false alarm', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { ctx, healthChanges } = await startReceiveSession();

    try {
      firePacket(ctx, HEARTBEAT_CMD);

      vi.advanceTimersByTime(90_000);
      vi.advanceTimersByTime(14_999);
      firePacket(ctx, HEARTBEAT_CMD, '10001', 2);
      vi.advanceTimersByTime(1);

      expect(ctx.session.receiveHealthy).toBe(true);
      expect(healthChanges).toEqual([]);
    } finally {
      ctx.session.dispose();
      vi.useRealTimers();
    }
  });

  it('does not carry an armed watchdog across a direct account switch', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { ctx, healthChanges } = await startReceiveSession();

    try {
      firePacket(ctx, HEARTBEAT_CMD);

      ctx.currentClient().fireLogin('20002');
      vi.advanceTimersByTime(10 * 60_000);

      expect(ctx.session.receiveHealthy).toBe(true);
      expect(healthChanges).toEqual([]);
    } finally {
      ctx.session.dispose();
      vi.useRealTimers();
    }
  });

  it('requires the new account heartbeat after packet-driven PID migration', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const { ctx, healthChanges } = await startReceiveSession();

    try {
      firePacket(ctx, HEARTBEAT_CMD);
      firePacket(ctx, MESSAGE_CMD, '20002', 2);
      vi.advanceTimersByTime(10 * 60_000);

      expect(ctx.session.receiveHealthy).toBe(true);
      expect(healthChanges).toEqual([]);

      firePacket(ctx, HEARTBEAT_CMD, '20002', 3);
      vi.advanceTimersByTime(105_000);

      expect(ctx.session.receiveHealthy).toBe(false);
      expect(healthChanges).toEqual([false]);
    } finally {
      ctx.session.dispose();
      vi.useRealTimers();
    }
  });

  it('counts an invalid-UIN frame as receive activity without routing it', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'Date'] });
    const onPacket = vi.fn();
    const { ctx, healthChanges } = await startReceiveSession(onPacket);

    try {
      firePacket(ctx, HEARTBEAT_CMD);
      onPacket.mockClear();

      vi.advanceTimersByTime(80_000);
      firePacket(ctx, 'trpc.status.invalid-uin-probe', '0', 2);
      vi.advanceTimersByTime(104_999);

      expect(ctx.session.receiveHealthy).toBe(true);
      expect(onPacket).not.toHaveBeenCalled();

      vi.advanceTimersByTime(1);
      expect(ctx.session.receiveHealthy).toBe(false);

      firePacket(ctx, 'trpc.status.invalid-uin-probe', '0', 3);

      expect(ctx.session.receiveHealthy).toBe(true);
      expect(healthChanges).toEqual([false, true]);
      expect(onPacket).not.toHaveBeenCalled();
    } finally {
      ctx.session.dispose();
      vi.useRealTimers();
    }
  });
});

describe('HookSession — login reconcile does not stack concurrent probes', () => {
  it('skips overlapping ticks while a slow probe is in flight', async () => {
    vi.useFakeTimers();
    try {
      // A probe that never resolves — simulates a slow port scan spanning
      // multiple intervals. The in-flight guard must call it only once.
      const probeLogin = vi.fn(() => new Promise<never>(() => { /* pending */ }));
      const ctx = makeSession({ pipeLive: true, probeLogin });

      await ctx.session.load();
      ctx.session.onPipeUp();
      await vi.advanceTimersByTimeAsync(0);      // connect + immediate probe (starts, stays pending)
      await vi.advanceTimersByTimeAsync(9000);   // 3 more interval ticks

      expect(probeLogin).toHaveBeenCalledTimes(1); // not stacked
    } finally {
      vi.useRealTimers();
    }
  });
});
