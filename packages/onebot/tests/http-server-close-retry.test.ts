import { describe, expect, it, vi } from 'vitest';
import type { IncomingMessage, ServerResponse } from 'http';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { HttpServerNetwork } from '../src/types';

let apiAccepting = true;
const CTX: NetworkAdapterContext = {
  uin: '10001',
  api: {
    get isAcceptingActions() { return apiAccepting; },
  } as never,
  buildLifecycleEvent: () => ({}),
  buildHeartbeatEvent: () => ({}),
};

describe('HttpServerAdapter close ownership', () => {
  it('retains the server reference after callback failure and retries it', async () => {
    apiAccepting = true;
    const config: HttpServerNetwork = {
      name: 'http',
      host: '127.0.0.1',
      port: 3000,
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    const adapter = new HttpServerAdapter('http', config, CTX);
    let callback: ((error?: Error) => void) | null = null;
    const server = {
      listening: true,
      close(next: (error?: Error) => void) { callback = next; },
    };
    Object.assign(adapter as unknown as Record<string, unknown>, {
      server,
      isEnabled: true,
      listening: true,
      acceptingActions: true,
    });

    const firstClose = adapter.close();
    callback!(new Error('release failed'));
    await expect(firstClose).rejects.toThrow('release failed');
    expect((adapter as unknown as { server: unknown }).server).toBe(server);
    expect(adapter.describeStatus().status).toBe('ok');

    expect((adapter as unknown as { acceptingActions: boolean }).acceptingActions).toBe(true);
    apiAccepting = false;
    const response = {
      headersSent: false,
      writableEnded: false,
      destroyed: false,
      statusCode: 0,
      setHeader: vi.fn(),
      end: vi.fn(),
    } as unknown as ServerResponse;
    (adapter as unknown as {
      trackInboundAction(req: IncomingMessage, res: ServerResponse): void;
    }).trackInboundAction({} as IncomingMessage, response);
    expect(response.statusCode).toBe(503);
    expect(response.end).toHaveBeenCalledWith(expect.stringContaining('server closing'));

    const secondClose = adapter.close();
    callback!();
    await secondClose;
    expect((adapter as unknown as { server: unknown }).server).toBeNull();
    expect(adapter.describeStatus().status).toBe('disabled');
  });

  it('keeps the embedded upgrade handler when HTTP release fails, then retries both owners', async () => {
    apiAccepting = true;
    const config: HttpServerNetwork = {
      name: 'combined',
      host: '127.0.0.1',
      port: 3000,
      enableWebSocket: true,
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    const adapter = new HttpServerAdapter('combined', config, CTX);
    let httpClose: ((error?: Error) => void) | null = null;
    let webSocketClose: ((error?: Error) => void) | null = null;
    const server = {
      listening: true,
      close(next: (error?: Error) => void) { httpClose = next; },
    };
    const webSocketServer = {
      close: vi.fn((next?: (error?: Error) => void) => { webSocketClose = next ?? null; }),
    };
    const internals = adapter as unknown as {
      webSocketConnections: { startAccepting(): void; isAcceptingActions: boolean };
    };
    internals.webSocketConnections.startAccepting();
    Object.assign(adapter as unknown as Record<string, unknown>, {
      server,
      webSocketServer,
      isEnabled: true,
      listening: true,
      acceptingActions: true,
    });

    const firstClose = adapter.close();
    httpClose!(new Error('http release failed'));
    await expect(firstClose).rejects.toThrow('http release failed');
    expect(webSocketServer.close).not.toHaveBeenCalled();
    expect(internals.webSocketConnections.isAcceptingActions).toBe(true);
    expect(adapter.describeStatus().status).toBe('ok');

    const secondClose = adapter.close();
    httpClose!();
    await vi.waitFor(() => expect(webSocketServer.close).toHaveBeenCalledOnce());
    webSocketClose!();
    await secondClose;

    expect((adapter as unknown as { server: unknown }).server).toBeNull();
    expect((adapter as unknown as { webSocketServer: unknown }).webSocketServer).toBeNull();
    expect(adapter.describeStatus().status).toBe('disabled');
  });

  it('keeps only the embedded upgrade handler when its release fails, then retries it alone', async () => {
    apiAccepting = true;
    const config: HttpServerNetwork = {
      name: 'combined',
      host: '127.0.0.1',
      port: 3000,
      enableWebSocket: true,
      messageFormat: 'array',
      reportSelfMessage: false,
    };
    const adapter = new HttpServerAdapter('combined', config, CTX);
    let httpClose: ((error?: Error) => void) | null = null;
    let webSocketClose: ((error?: Error) => void) | null = null;
    const server = {
      listening: true,
      close: vi.fn((next: (error?: Error) => void) => { httpClose = next; }),
    };
    const webSocketServer = {
      close: vi.fn((next?: (error?: Error) => void) => { webSocketClose = next ?? null; }),
    };
    Object.assign(adapter as unknown as Record<string, unknown>, {
      server,
      webSocketServer,
      isEnabled: true,
      listening: true,
      acceptingActions: true,
    });

    const firstClose = adapter.close();
    httpClose!();
    await vi.waitFor(() => expect(webSocketServer.close).toHaveBeenCalledOnce());
    webSocketClose!(new Error('websocket release failed'));
    await expect(firstClose).rejects.toThrow('websocket release failed');

    expect(server.close).toHaveBeenCalledOnce();
    expect((adapter as unknown as { server: unknown }).server).toBeNull();
    expect((adapter as unknown as { webSocketServer: unknown }).webSocketServer).toBe(webSocketServer);
    expect(adapter.describeStatus().status).toBe('disabled');

    const secondClose = adapter.close();
    await vi.waitFor(() => expect(webSocketServer.close).toHaveBeenCalledTimes(2));
    webSocketClose!();
    await secondClose;

    expect(server.close).toHaveBeenCalledOnce();
    expect((adapter as unknown as { server: unknown }).server).toBeNull();
    expect((adapter as unknown as { webSocketServer: unknown }).webSocketServer).toBeNull();
    expect(adapter.describeStatus().status).toBe('disabled');
  });
});
