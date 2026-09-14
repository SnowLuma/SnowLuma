// Hot-reload tests for HttpServerAdapter — pins the contract that
// `reload({ accessToken: <new> })` must take effect on the very next
// request without the listener being torn down. Earlier the adapter
// captured `accessToken` into a `startServer()` closure and relied on
// `bindingSignature` to trigger a `close()` + `open()` round-trip on
// token change; that race-prone path is gone and `handleRequest` now
// reads `this.config.accessToken` per request.

import { describe, expect, it, vi, afterEach } from 'vitest';
import http from 'http';
import type { AddressInfo } from 'net';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import { NetworkReloadType, type NetworkAdapterContext } from '../src/network/adapter';
import type { HttpServerNetwork } from '../src/types';

function fakeCtx(): NetworkAdapterContext {
  return {
    uin: '10001',
    api: {
      handle: vi.fn(async () => ({ status: 'ok', retcode: 0, data: { online: true } })),
    } as any,
    buildLifecycleEvent: vi.fn(() => ({})),
    buildHeartbeatEvent: vi.fn(() => ({})),
  };
}

function get(port: number, path: string, headers: Record<string, string> = {}): Promise<{ status: number }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: '127.0.0.1', port, path, method: 'GET', headers },
      (res) => {
        res.on('data', () => { /* drain */ });
        res.on('end', () => resolve({ status: res.statusCode! }));
      },
    );
    req.on('error', reject);
    req.end();
  });
}

// Wait until the underlying http.Server has bound its port; tests that
// hit the socket too early get ECONNREFUSED on slow CI hosts.
async function waitForListen(adapter: HttpServerAdapter): Promise<number> {
  for (let i = 0; i < 50; i++) {
    const server = (adapter as any).server as http.Server | null;
    const addr = server?.address() as AddressInfo | null | undefined;
    if (addr && typeof addr === 'object') return addr.port;
    await new Promise((r) => setTimeout(r, 20));
  }
  throw new Error('http server never started listening');
}

describe('HttpServerAdapter — accessToken hot reload', () => {
  let adapter: HttpServerAdapter | null = null;

  afterEach(async () => {
    await adapter?.close();
    adapter = null;
  });

  it('a swapped accessToken authorizes the new token on the next request — no listener re-bind', async () => {
    const ctx = fakeCtx();
    // port=0 → OS-assigned; the swap proves no re-bind happens because
    // a re-bind would land on a different port and `waitForListen`
    // would diverge from the original.
    const config: HttpServerNetwork = {
      name: 'hot', port: 0, enabled: true, accessToken: 'tok-1',
      messageFormat: 'array', reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter('hot', config, ctx);
    await adapter.open();
    const portBefore = await waitForListen(adapter);

    // Sanity: old token authorizes, anything else 401s.
    expect((await get(portBefore, '/', { authorization: 'Bearer tok-1' })).status).toBe(200);
    expect((await get(portBefore, '/', { authorization: 'Bearer tok-2' })).status).toBe(401);

    // Hot-swap the token.
    await adapter.reload({ ...config, accessToken: 'tok-2' });

    // Same port (no re-bind) — and the new token must take effect on
    // the very next request.
    const portAfter = ((adapter as any).server as http.Server).address() as AddressInfo;
    expect(portAfter.port).toBe(portBefore);

    expect((await get(portBefore, '/', { authorization: 'Bearer tok-1' })).status).toBe(401);
    expect((await get(portBefore, '/', { authorization: 'Bearer tok-2' })).status).toBe(200);
  });

  it('clearing accessToken to empty disables auth on the next request', async () => {
    const ctx = fakeCtx();
    const config: HttpServerNetwork = {
      name: 'hot-clear', port: 0, enabled: true, accessToken: 'tok-1',
      messageFormat: 'array', reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter('hot-clear', config, ctx);
    await adapter.open();
    const port = await waitForListen(adapter);

    expect((await get(port, '/')).status).toBe(401); // no token header → 401

    await adapter.reload({ ...config, accessToken: '' });

    expect((await get(port, '/')).status).toBe(200); // auth disabled
  });

  it('setting accessToken from empty enforces auth on the next request', async () => {
    const ctx = fakeCtx();
    const config: HttpServerNetwork = {
      name: 'hot-add', port: 0, enabled: true,
      messageFormat: 'array', reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter('hot-add', config, ctx);
    await adapter.open();
    const port = await waitForListen(adapter);

    expect((await get(port, '/')).status).toBe(200); // no auth configured

    await adapter.reload({ ...config, accessToken: 'tok-new' });

    expect((await get(port, '/')).status).toBe(401); // auth now required
    expect((await get(port, '/', { authorization: 'Bearer tok-new' })).status).toBe(200);
  });

  it('changing only accessToken returns NetworkReloadType.Normal — no Reopened/Closed', async () => {
    const ctx = fakeCtx();
    const config: HttpServerNetwork = {
      name: 'hot-type', port: 0, enabled: true, accessToken: 'a',
      messageFormat: 'array', reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter('hot-type', config, ctx);
    await adapter.open();
    await waitForListen(adapter);

    const reloadType = await adapter.reload({ ...config, accessToken: 'b' });
    // Without re-binding, the adapter reports `Normal` — anything but
    // `Reopened` / `Closed` is acceptable; we mostly care that nothing
    // touched the listener.
    expect(reloadType).toBe(NetworkReloadType.Normal);
  });

  it('rejects open only after an occupied-port bind actually fails', async () => {
    const blocker = http.createServer();
    await new Promise<void>((resolve, reject) => {
      blocker.once('error', reject);
      blocker.listen(0, '127.0.0.1', resolve);
    });
    const address = blocker.address() as AddressInfo;
    const config: HttpServerNetwork = {
      name: 'occupied',
      host: '127.0.0.1',
      port: address.port,
      enabled: true,
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter('occupied', config, fakeCtx());

    try {
      await expect(adapter.open()).rejects.toMatchObject({ code: 'EADDRINUSE' });
      expect(adapter.describeManagedStatus()).toMatchObject({
        status: 'degraded',
        lastError: expect.stringContaining('EADDRINUSE'),
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        blocker.close((error) => error ? reject(error) : resolve());
      });
    }
  });

  it('close resolves only after the port can be rebound', async () => {
    const config: HttpServerNetwork = {
      name: 'release',
      host: '127.0.0.1',
      port: 0,
      enabled: true,
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    adapter = new HttpServerAdapter('release', config, fakeCtx());
    await adapter.open();
    const port = ((adapter as any).server as http.Server).address() as AddressInfo;
    await adapter.close();
    adapter = null;

    const rebound = http.createServer();
    try {
      await new Promise<void>((resolve, reject) => {
        rebound.once('error', reject);
        rebound.listen(port.port, '127.0.0.1', resolve);
      });
    } finally {
      await new Promise<void>((resolve, reject) => {
        rebound.close((error) => error ? reject(error) : resolve());
      });
    }
  });
});
