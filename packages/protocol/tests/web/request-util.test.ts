import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

const servers = new Set<http.Server>();

async function serve(
  handler: http.RequestListener,
): Promise<{ server: http.Server; url: string }> {
  const server = http.createServer(handler);
  servers.add(server);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', resolve);
  });
  const address = server.address() as AddressInfo;
  return { server, url: `http://127.0.0.1:${address.port}` };
}

afterEach(async () => {
  await Promise.all([...servers].map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
  }));
});

describe('RequestUtil bounded text responses', () => {
  it('rejects a response once it exceeds the byte limit', async () => {
    const { url } = await serve((_req, res) => {
      res.end('x'.repeat(65));
    });

    await expect(RequestUtil.HttpGetText(
      url,
      'GET',
      undefined,
      {},
      { maxResponseBytes: 64 },
    )).rejects.toThrow('response body exceeds 64 bytes');
  });

  it('rejects a request that does not complete before its deadline', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200);
      res.write('partial');
    });

    await expect(RequestUtil.HttpGetText(
      url,
      'GET',
      undefined,
      {},
      { timeoutMs: 30 },
    )).rejects.toThrow('request timed out after 30 ms');
  });

  it('measures the response limit in bytes and accepts the exact boundary', async () => {
    const exact = '界'.repeat(16);
    const { url } = await serve((_req, res) => {
      res.end(exact);
    });

    await expect(RequestUtil.HttpGetText(
      url,
      'GET',
      undefined,
      {},
      { maxResponseBytes: Buffer.byteLength(exact) },
    )).resolves.toBe(exact);
  });

  it('rejects a multibyte response that exceeds the byte boundary', async () => {
    const tooLarge = '界'.repeat(17);
    const { url } = await serve((_req, res) => {
      res.end(tooLarge);
    });

    await expect(RequestUtil.HttpGetText(
      url,
      'GET',
      undefined,
      {},
      { maxResponseBytes: 48 },
    )).rejects.toThrow('response body exceeds 48 bytes');
  });

  it('closes a non-success response without waiting for its body to end', async () => {
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const { url } = await serve((_req, res) => {
      res.once('close', markClosed);
      res.writeHead(403);
      res.flushHeaders();
      res.write('body that never ends');
    });

    await expect(RequestUtil.HttpGetText(url)).rejects.toThrow('Unexpected status code: 403');
    await expect(Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ])).resolves.toBe(true);
  });
});

describe('RequestUtil redirects', () => {
  it('strips credentials when a redirect crosses origins', async () => {
    let redirectedHeaders: http.IncomingHttpHeaders | undefined;
    const target = await serve((req, res) => {
      redirectedHeaders = req.headers;
      res.end('ok');
    });
    const source = await serve((_req, res) => {
      res.writeHead(302, { location: target.url });
      res.end();
    });

    await expect(RequestUtil.HttpGetText(
      source.url,
      'GET',
      undefined,
      {
        Cookie: 'uin=secret',
        Authorization: 'Bearer secret',
        'Proxy-Authorization': 'Basic secret',
        'X-SnowLuma-Test': 'kept',
      },
    )).resolves.toBe('ok');

    expect(redirectedHeaders?.cookie).toBeUndefined();
    expect(redirectedHeaders?.authorization).toBeUndefined();
    expect(redirectedHeaders?.['proxy-authorization']).toBeUndefined();
    expect(redirectedHeaders?.['x-snowluma-test']).toBe('kept');
  });

  it('never forwards a write request body across origins', async () => {
    let targetReached = false;
    const target = await serve((_req, res) => {
      targetReached = true;
      res.end('unexpected');
    });
    const source = await serve((_req, res) => {
      res.writeHead(307, { location: target.url });
      res.end();
    });

    await expect(RequestUtil.HttpGetText(
      source.url,
      'POST',
      'secret-body',
      { 'Content-Type': 'text/plain' },
    )).rejects.toThrow('cross-origin redirect cannot forward method POST');
    expect(targetReached).toBe(false);
  });

  it('preserves credentials for same-origin redirects', async () => {
    let redirectedCookie: string | undefined;
    const { url } = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, { location: '/finish' });
        res.end();
        return;
      }
      redirectedCookie = req.headers.cookie;
      res.end('ok');
    });

    await expect(RequestUtil.HttpGetText(
      `${url}/start`,
      'GET',
      undefined,
      { Cookie: 'uin=same-origin' },
    )).resolves.toBe('ok');
    expect(redirectedCookie).toBe('uin=same-origin');
  });

  it('inherits response limits after a redirect', async () => {
    const target = await serve((_req, res) => {
      res.end('x'.repeat(65));
    });
    const source = await serve((_req, res) => {
      res.writeHead(302, { location: target.url });
      res.end();
    });

    await expect(RequestUtil.HttpGetText(
      source.url,
      'GET',
      undefined,
      {},
      { maxResponseBytes: 64 },
    )).rejects.toThrow('response body exceeds 64 bytes');
  });

  it('shares one wall-clock deadline across the redirect chain', async () => {
    const target = await serve((_req, res) => {
      setTimeout(() => res.end('late'), 80);
    });
    const source = await serve((_req, res) => {
      setTimeout(() => {
        res.writeHead(302, { location: target.url });
        res.end();
      }, 80);
    });

    await expect(RequestUtil.HttpGetText(
      source.url,
      'GET',
      undefined,
      {},
      { timeoutMs: 100 },
    )).rejects.toThrow('request timed out after 100 ms');
  });

  it('rejects malformed redirect locations instead of throwing outside the Promise', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(302, { location: 'http://[' });
      res.end();
    });

    await expect(RequestUtil.HttpGetText(url)).rejects.toThrow('invalid redirect location');
  });

  it('rejects redirects to non-HTTP protocols', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(302, { location: 'file:///tmp/not-a-web-response' });
      res.end();
    });

    await expect(RequestUtil.HttpGetText(url)).rejects.toThrow(
      'unsupported redirect protocol: file:',
    );
  });

  it('closes the previous response before following a redirect', async () => {
    const target = await serve((_req, res) => {
      res.end('ok');
    });
    let markClosed!: () => void;
    const closed = new Promise<void>((resolve) => { markClosed = resolve; });
    const source = await serve((_req, res) => {
      res.once('close', markClosed);
      res.writeHead(302, { location: target.url });
      res.flushHeaders();
      res.write('body that never ends');
    });

    await expect(RequestUtil.HttpGetText(source.url)).resolves.toBe('ok');
    await expect(Promise.race([
      closed.then(() => true),
      new Promise<boolean>((resolve) => setTimeout(() => resolve(false), 250)),
    ])).resolves.toBe(true);
  });
});
