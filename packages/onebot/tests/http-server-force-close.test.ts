import { once } from 'node:events';
import http from 'node:http';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { describe, expect, it } from 'vitest';
import type { NetworkAdapterContext } from '../src/network/adapter';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import type { HttpServerNetwork } from '../src/types';

describe('HttpServerAdapter forced release', () => {
  it('drops a held connection so the port can be bound again', async () => {
    const ctx = {
      uin: '10001',
      api: { handle: async () => ({ status: 'ok', retcode: 0, data: null }), isStreamAction: () => false },
      buildLifecycleEvent: () => ({}),
      buildHeartbeatEvent: () => ({}),
    } as unknown as NetworkAdapterContext;
    const config: HttpServerNetwork = {
      name: 'http-force-close',
      host: '127.0.0.1',
      port: 0,
      path: '/',
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    const adapter = new HttpServerAdapter(config.name, config, ctx);
    let socket: net.Socket | null = null;
    try {
      await adapter.open();
      const server = (adapter as unknown as { server: http.Server | null }).server;
      expect(server).not.toBeNull();
      const port = (server!.address() as AddressInfo).port;
      socket = net.connect({ host: '127.0.0.1', port });
      await once(socket, 'connect');

      adapter.forceClose();

      expect(server!.listening).toBe(false);
      await expect(listenOn(port)).resolves.toBeUndefined();
    } finally {
      socket?.destroy();
      await adapter.close();
    }
  });
});

function listenOn(port: number): Promise<void> {
  const server = net.createServer();
  return new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', () => {
      server.close(() => resolve());
    });
  });
}
