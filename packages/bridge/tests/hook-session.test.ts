import { describe, it, expect, vi } from 'vitest';
import { EventEmitter } from 'events';
import { HookSession } from '../src/hook-session';
import type { ManualMapHandle } from '../src/injector';
import type { QqHookClient, QqHookPacket } from '../src/qq-hook-client';
import type { PacketSink } from '@snowluma/common/protocol-types';

const DUMMY_HANDLE: ManualMapHandle = { base: 0n, entry: 0n, exceptionTable: 0n, size: 0 };

/** Minimal stand-in for QqHookClient. Tests drive login/packet/error/close
 * events directly via fire* helpers. connectAll succeeds unless told otherwise. */
class FakeClient extends EventEmitter {
  isClosed = false;
  isLoggedIn = false;
  shouldFailConnect = false;
  private loginState = { loggedIn: false, uin: '0', uinNumber: 0n };

  async connectAll(_opts: { recv: boolean }): Promise<void> {
    if (this.shouldFailConnect) throw new Error('connect failed');
    if (this.isClosed) throw new Error('client is closed');
  }
  getLoginState() { return { ...this.loginState }; }
  close(): void {
    if (this.isClosed) return;
    this.isClosed = true;
    this.emit('close');
  }

  fireLogin(uin: string): void {
    this.isLoggedIn = true;
    this.loginState = { loggedIn: true, uin, uinNumber: BigInt(uin) };
    this.emit('loginState', { ...this.loginState });
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
} = {}) {
  const pid = opts.pid ?? 1234;
  let pipeLive = opts.pipeLive ?? false;
  const clients: FakeClient[] = [];
  const injector = {
    inject: vi.fn(() => ({ method: 'loadModuleManual' as const, handle: DUMMY_HANDLE })),
    unload: vi.fn(),
  };

  const session = new HookSession(pid, {
    injector,
    makeClient: () => {
      const c = new FakeClient();
      if (opts.clientFailsConnect) c.shouldFailConnect = true;
      clients.push(c);
      // Cast: FakeClient mirrors only the surface HookSession touches.
      return c as unknown as QqHookClient;
    },
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
