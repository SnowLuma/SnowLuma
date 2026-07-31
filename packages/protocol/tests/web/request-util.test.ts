import http from 'node:http';
import type { AddressInfo } from 'node:net';
import {
  getLogLevel,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RequestUtil } from '@snowluma/protocol/web/request-util';

const previousLogLevel = getLogLevel();

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
  setLogLevel(previousLogLevel);
  vi.useRealTimers();
  await Promise.all([...servers].map(async (server) => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    servers.delete(server);
  }));
});

function httpTrace(entries: LogEntry[]): LogEntry[] {
  return entries.filter((entry) => entry.level === 'trace' && entry.scope === 'Protocol.Http');
}

describe('RequestUtil TRACE lifecycle', () => {
  it('records complete request and parsed response data under one request context', async () => {
    const { url } = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks).toString()).toBe('{"message":"request-secret"}');
      res.setHeader('X-Response-Token', 'response-secret-header');
      res.end('{"ok":true,"token":"response-secret-body"}');
    });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpGetJson(
        `${url}/write?access_token=url-secret`,
        'POST',
        { message: 'request-secret' },
        {
          Authorization: 'Bearer request-secret-header',
          'Content-Type': 'application/json',
        },
      )).resolves.toEqual({ ok: true, token: 'response-secret-body' });

      const trace = httpTrace(entries);
      expect(trace.length).toBeGreaterThanOrEqual(4);
      expect(trace.every((entry) => entry.req !== undefined && entry.req === trace[0]!.req)).toBe(true);
      expect(trace.map((entry) => entry.message)).toEqual(expect.arrayContaining([
        expect.stringContaining('http_start method="POST"'),
        expect.stringContaining('access_token=url-secret'),
        expect.stringContaining('request-secret-header'),
        expect.stringContaining('request-secret'),
        expect.stringContaining('http_response status=200'),
        expect.stringContaining('response-secret-header'),
        expect.stringContaining('response-secret-body'),
        expect.stringContaining('http_branch branch=parse_completed'),
        expect.stringMatching(/^http_terminal method="POST" .* outcome=completed reason=response_complete elapsedMs=\d+$/),
      ]));
      expect(trace.filter((entry) => entry.message.startsWith('http_terminal '))).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('records exact request and response bytes for binary HTTP data', async () => {
    const requestBytes = Uint8Array.from([0x00, 0xff, 0x80, 0x41]);
    const responseBytes = Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00]);
    const { url } = await serve(async (req, res) => {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(Buffer.from(chunk));
      expect(Buffer.concat(chunks)).toEqual(Buffer.from(requestBytes));
      res.end(responseBytes);
    });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpGetText(
        url,
        'POST',
        requestBytes,
        { 'Content-Type': 'application/octet-stream' },
      )).resolves.toBe(responseBytes.toString());

      const messages = httpTrace(entries).map((entry) => entry.message);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringContaining('requestBytes=4 requestHex=00ff8041'),
        expect.stringContaining('bodyBytes=5 bodyHex=deadbeef00'),
      ]));
    } finally {
      unsubscribe();
    }
  });

  it('records redirect input changes and one non-2xx terminal without waiting for the body', async () => {
    const target = await serve((_req, res) => {
      res.writeHead(403, { 'X-Diagnostic': 'denied' });
      res.flushHeaders();
      res.write('body that never ends');
    });
    const source = await serve((_req, res) => {
      res.writeHead(302, { location: target.url });
      res.end();
    });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpGetText(
        source.url,
        'GET',
        undefined,
        { Cookie: 'uin=redirect-secret' },
      )).rejects.toThrow('Unexpected status code: 403');

      const messages = httpTrace(entries).map((entry) => entry.message);
      expect(messages).toEqual(expect.arrayContaining([
        expect.stringContaining('http_branch branch=redirect status=302'),
        expect.stringContaining(`to=${JSON.stringify(`${target.url}/`)}`),
        expect.stringContaining('http_response status=403'),
        expect.stringContaining('bodyState=not_read'),
        expect.stringMatching(/^http_terminal method="GET" .* outcome=failed reason=non_2xx .*elapsedMs=\d+$/),
      ]));
      expect(messages.filter((message) => message.startsWith('http_terminal '))).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    'not a valid URL',
    'file:///tmp/not-a-web-request',
  ])('classifies invalid initial request URL %j without falling back to transport or redirect failure', async (url) => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpGetText(url)).rejects.toThrow();
      const terminals = httpTrace(entries)
        .filter((entry) => entry.message.startsWith('http_terminal '));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.message).toContain('outcome=failed reason=request_invalid');
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ['timeoutMs', { timeoutMs: 0 }],
    ['maxResponseBytes', { maxResponseBytes: 0 }],
  ] as const)('traces invalid %s before rejecting the request', async (_name, limits) => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpGetText(
        'http://127.0.0.1/',
        'GET',
        undefined,
        {},
        limits,
      )).rejects.toThrow('must be a positive safe integer');
      const trace = httpTrace(entries);
      expect(trace.some((entry) => entry.message.startsWith('http_start '))).toBe(true);
      const terminals = trace.filter((entry) => entry.message.startsWith('http_terminal '));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.message).toContain('outcome=failed reason=request_invalid');
    } finally {
      unsubscribe();
    }
  });

  it.each([
    {
      name: 'method token',
      run: () => RequestUtil.HttpGetText('http://127.0.0.1:1/', 'BAD METHOD'),
    },
    {
      name: 'header value',
      run: () => RequestUtil.HttpGetText(
        'http://127.0.0.1:1/',
        'GET',
        undefined,
        { 'X-Invalid': 'line one\nline two' },
      ),
    },
    {
      name: 'circular JSON body',
      run: () => {
        const body: Record<string, unknown> = {};
        body.self = body;
        return RequestUtil.HttpGetJson('http://127.0.0.1:1/', 'POST', body);
      },
    },
  ])('classifies an invalid local $name as request_invalid', async ({ run }) => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(run()).rejects.toThrow();
      const terminals = httpTrace(entries)
        .filter((entry) => entry.message.startsWith('http_terminal '));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.message).toContain('outcome=failed reason=request_invalid');
    } finally {
      unsubscribe();
    }
  });

  it.each([
    {
      name: 'parse failure',
      run: async () => {
        const { url } = await serve((_req, res) => res.end('{invalid-json'));
        return RequestUtil.HttpGetJson(url);
      },
      reason: 'parse_failure',
      outcome: 'failed',
      bodyState: undefined,
    },
    {
      name: 'timeout',
      run: async () => {
        const { url } = await serve((_req, res) => {
          res.writeHead(200);
          res.write('partial');
        });
        return RequestUtil.HttpGetText(url, 'GET', undefined, {}, { timeoutMs: 30 });
      },
      reason: 'deadline',
      outcome: 'timeout',
      bodyState: 'deadline',
    },
    {
      name: 'transport failure',
      run: async () => {
        const { url } = await serve((req) => req.socket.destroy());
        return RequestUtil.HttpGetText(url);
      },
      reason: 'transport_failure',
      outcome: 'failed',
      bodyState: undefined,
    },
    {
      name: 'response cancellation',
      run: async () => {
        const { url } = await serve((_req, res) => {
          res.writeHead(200, { 'Content-Length': '100' });
          res.flushHeaders();
          res.write('partial');
          setImmediate(() => res.destroy());
        });
        return RequestUtil.HttpGetText(url, 'GET', undefined, {}, { timeoutMs: 250 });
      },
      reason: 'response_aborted',
      outcome: 'cancelled',
      bodyState: 'aborted',
    },
  ])('records a unique $name terminal', async ({ run, reason, outcome, bodyState }) => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(run()).rejects.toThrow();
      const terminals = httpTrace(entries)
        .filter((entry) => entry.message.startsWith('http_terminal '));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.message).toContain(`outcome=${outcome} reason=${reason}`);
      if (bodyState !== undefined) {
        expect(httpTrace(entries).map((entry) => entry.message)).toEqual(expect.arrayContaining([
          expect.stringContaining(
            `bodyState=${bodyState} bodyBytes=7 bodyHex=7061727469616c body="partial"`,
          ),
        ]));
      }
    } finally {
      unsubscribe();
    }
  });
});

describe('RequestUtil cookie redirect TRACE lifecycle', () => {
  it('records collected cookies and a completed terminal across redirects', async () => {
    const { url } = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, {
          location: '/finish',
          'Set-Cookie': 'p_skey=first-secret; Path=/',
        });
        res.end();
        return;
      }
      res.writeHead(200, { 'Set-Cookie': 'skey=second-secret; Path=/' });
      res.end('ok');
    });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpsGetCookies(`${url}/start`)).resolves.toEqual({
        p_skey: 'first-secret',
        skey: 'second-secret',
      });
      const trace = httpTrace(entries);
      expect(trace.every((entry) => entry.req !== undefined && entry.req === trace[0]!.req)).toBe(true);
      expect(trace.map((entry) => entry.message)).toEqual(expect.arrayContaining([
        expect.stringContaining('http_cookie_start'),
        expect.stringContaining('branch=redirect'),
        expect.stringContaining('first-secret'),
        expect.stringContaining('second-secret'),
        expect.stringContaining('bodyBytes=2 bodyHex=6f6b body="ok"'),
        expect.stringMatching(/^http_cookie_terminal .* outcome=completed reason=response_complete .*elapsedMs=\d+$/),
      ]));
      expect(trace.filter((entry) => entry.message.startsWith('http_cookie_terminal '))).toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('fails open when a cookie response aborts after headers', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, {
        'Content-Length': '100',
        'Set-Cookie': 'p_skey=partial-secret; Path=/',
      });
      res.flushHeaders();
      res.write('partial');
      setImmediate(() => res.destroy());
    });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpsGetCookies(url)).resolves.toEqual({
        p_skey: 'partial-secret',
      });
      const terminals = httpTrace(entries)
        .filter((entry) => entry.message.startsWith('http_cookie_terminal '));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.message).toContain(
        'outcome=completed reason=transport_failure failOpen=true',
      );
    } finally {
      unsubscribe();
    }
  });

  it('traces partial cookie response bytes before a fail-open deadline terminal', async () => {
    const { url } = await serve((_req, res) => {
      res.writeHead(200, {
        'Content-Length': '100',
        'Set-Cookie': 'p_skey=partial-secret; Path=/',
      });
      res.flushHeaders();
      res.write('partial');
    });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpsGetCookies(url)).resolves.toEqual({
        p_skey: 'partial-secret',
      });
      await new Promise<void>((resolve) => setImmediate(resolve));

      const messages = httpTrace(entries).map((entry) => entry.message);
      const bodyIndex = messages.findIndex((message) =>
        message.includes('http_cookie_body ')
        && message.includes('bodyBytes=7 bodyHex=7061727469616c body="partial"'));
      const terminalIndex = messages.findIndex((message) =>
        message.includes('http_cookie_terminal ')
        && message.includes('reason=deadline failOpen=true'));
      expect(bodyIndex).toBeGreaterThanOrEqual(0);
      expect(terminalIndex).toBeGreaterThan(bodyIndex);
    } finally {
      unsubscribe();
    }
  }, 10_000);

  it('records a fail-open transport terminal while returning cookies collected earlier', async () => {
    const { url } = await serve((req, res) => {
      if (req.url === '/start') {
        res.writeHead(302, {
          location: '/broken',
          'Set-Cookie': 'p_skey=collected-secret; Path=/',
        });
        res.end();
        return;
      }
      req.socket.destroy(new Error('fixture cookie transport reset'));
    });
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpsGetCookies(`${url}/start`)).resolves.toEqual({
        p_skey: 'collected-secret',
      });
      const terminals = httpTrace(entries)
        .filter((entry) => entry.message.startsWith('http_cookie_terminal '));
      expect(terminals).toHaveLength(1);
      expect(terminals[0]!.message).toContain(
        'outcome=completed reason=transport_failure failOpen=true',
      );
      expect(terminals[0]!.message).toContain('collected-secret');
      expect(terminals[0]!.message).toContain('socket hang up');
    } finally {
      unsubscribe();
    }
  });
});

describe('RequestUtil bounded text responses', () => {
  it('rejects a response once it exceeds the byte limit and traces every observed byte', async () => {
    const entries: LogEntry[] = [];
    const body = 'x'.repeat(65);
    const { url } = await serve((_req, res) => {
      res.end(body);
    });
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    try {
      await expect(RequestUtil.HttpGetText(
        url,
        'GET',
        undefined,
        {},
        { maxResponseBytes: 64 },
      )).rejects.toThrow('response body exceeds 64 bytes');

      expect(httpTrace(entries).map((entry) => entry.message)).toEqual(expect.arrayContaining([
        expect.stringContaining(
          `bodyState=too_large bodyBytes=65 bodyHex=${'78'.repeat(65)}`,
        ),
      ]));
    } finally {
      unsubscribe();
    }
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
