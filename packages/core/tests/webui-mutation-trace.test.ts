import {
  getLogLevel,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { traceAuthenticatedWebuiMutation } from '../src/webui/mutation-trace';

const previousLogLevel = getLogLevel();

function mutationTrace(entries: LogEntry[]): LogEntry[] {
  return entries.filter(
    (entry) => entry.level === 'trace' && entry.scope === 'WebUI.Mutation',
  );
}

async function waitForTerminal(entries: LogEntry[]): Promise<LogEntry[]> {
  await vi.waitFor(() => {
    expect(mutationTrace(entries).some(
      (entry) => entry.message.startsWith('webui_mutation_terminal '),
    )).toBe(true);
  });
  return mutationTrace(entries);
}

describe('traceAuthenticatedWebuiMutation', () => {
  afterEach(() => {
    setLogLevel(previousLogLevel);
  });

  it('traces a successful JSON write with complete request and response data', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const requestBody = '{"logLevel":"trace"}';
    const responseBody = '{"success":true}';
    const request = new Request('http://127.0.0.1/api/system/settings?source=test', {
      method: 'POST',
      headers: {
        authorization: 'Bearer exact-token',
        'content-type': 'application/json',
        'x-request-detail': 'complete',
      },
      body: requestBody,
    });

    try {
      const response = await traceAuthenticatedWebuiMutation(request, async () => new Response(
        responseBody,
        {
          status: 201,
          headers: {
            'content-type': 'application/json',
            'x-response-detail': 'complete',
          },
        },
      ));

      expect(response.status).toBe(201);
      expect(await response.text()).toBe(responseBody);

      const trace = await waitForTerminal(entries);
      expect(trace).toHaveLength(4);
      expect(trace[0]!.message).toContain('webui_mutation_start method="POST"');
      expect(trace[0]!.message).toContain(
        'url="http://127.0.0.1/api/system/settings?source=test"',
      );
      expect(trace[0]!.message).toContain('authorization');
      expect(trace[0]!.message).toContain('Bearer exact-token');
      expect(trace[0]!.message).toContain('x-request-detail');
      expect(trace[1]!.message).toContain('branch=request_body');
      expect(trace[1]!.message).toContain(`text=${JSON.stringify(requestBody)}`);
      expect(trace[1]!.message).toContain(
        `body=${Buffer.from(requestBody).toString('hex')}`,
      );
      expect(trace[2]!.message).toContain('branch=response status=201');
      expect(trace[2]!.message).toContain('x-response-detail');
      expect(trace[2]!.message).toContain(`text=${JSON.stringify(responseBody)}`);
      expect(trace[2]!.message).toContain(
        `body=${Buffer.from(responseBody).toString('hex')}`,
      );
      expect(trace[3]!.message).toMatch(
        /^webui_mutation_terminal outcome=completed reason=response_completed status=201 elapsedMs=\d+$/,
      );
      expect(trace.every((entry) => entry.req === trace[0]!.req)).toBe(true);
      expect(trace[0]!.req).toEqual(expect.any(Number));
    } finally {
      unsubscribe();
    }
  });

  it('traces non-2xx and binary bodies without consuming the response', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const requestBytes = Uint8Array.from([0x00, 0xff, 0x80, 0x41]);
    const responseBytes = Uint8Array.from([0xde, 0xad, 0xbe, 0xef, 0x00]);

    try {
      const response = await traceAuthenticatedWebuiMutation(
        new Request('http://127.0.0.1/api/system/backup/import', {
          method: 'POST',
          headers: { 'content-type': 'application/octet-stream' },
          body: requestBytes,
        }),
        async () => new Response(responseBytes, {
          status: 422,
          headers: { 'content-type': 'application/octet-stream' },
        }),
      );

      expect(new Uint8Array(await response.arrayBuffer())).toEqual(responseBytes);
      const trace = await waitForTerminal(entries);
      expect(trace.find((entry) => entry.message.includes('branch=request_body'))?.message)
        .toContain('length=4');
      expect(trace.find((entry) => entry.message.includes('branch=request_body'))?.message)
        .toContain('body=00ff8041');
      expect(trace.find((entry) => entry.message.includes('branch=response'))?.message)
        .toContain('body=deadbeef00');
      expect(trace.at(-1)?.message).toMatch(
        /^webui_mutation_terminal outcome=failed reason=http_status status=422 elapsedMs=\d+$/,
      );
      expect(trace.filter((entry) => entry.message.startsWith('webui_mutation_terminal ')))
        .toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('traces a thrown handler with one failed terminal and preserves the error', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const failure = new Error('write exploded');

    try {
      await expect(traceAuthenticatedWebuiMutation(
        new Request('http://127.0.0.1/api/global-config', {
          method: 'POST',
          body: 'complete request',
        }),
        async () => { throw failure; },
      )).rejects.toBe(failure);

      const trace = mutationTrace(entries);
      expect(trace.some((entry) =>
        entry.message.includes('branch=request_body')
        && entry.message.includes('body=636f6d706c6574652072657175657374'))).toBe(true);
      expect(trace.at(-1)?.message).toMatch(
        /^webui_mutation_terminal outcome=failed reason=handler_threw error="write exploded" elapsedMs=\d+$/,
      );
      expect(trace.filter((entry) => entry.message.startsWith('webui_mutation_terminal ')))
        .toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it('classifies handler cancellation and timeout from their error provenance', async () => {
    setLogLevel('trace');

    for (const [name, outcome, reason] of [
      ['AbortError', 'cancelled', 'handler_cancelled'],
      ['TimeoutError', 'timeout', 'handler_timeout'],
    ] as const) {
      const entries: LogEntry[] = [];
      const unsubscribe = subscribeLogs((entry) => entries.push(entry));
      const failure = new DOMException(`${name} detail`, name);
      try {
        await expect(traceAuthenticatedWebuiMutation(
          new Request('http://127.0.0.1/api/processes/42/load', { method: 'POST' }),
          async () => { throw failure; },
        )).rejects.toBe(failure);
        expect(mutationTrace(entries).at(-1)?.message).toMatch(
          new RegExp(`^webui_mutation_terminal outcome=${outcome} reason=${reason} error="${name} detail" elapsedMs=\\d+$`),
        );
      } finally {
        unsubscribe();
      }
    }
  });

  it('bypasses cloning and logging when TRACE is disabled', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('info');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const request = new Request('http://127.0.0.1/api/system/settings', {
      method: 'POST',
      body: 'must remain unread',
    });
    const clone = vi.spyOn(request, 'clone');
    const next = vi.fn(async () => new Response('ok'));

    try {
      const response = await traceAuthenticatedWebuiMutation(request, next);
      expect(await response.text()).toBe('ok');
      expect(next).toHaveBeenCalledOnce();
      expect(clone).not.toHaveBeenCalled();
      expect(entries).toEqual([]);
    } finally {
      unsubscribe();
    }
  });

  it('does not clone the streamed upload request body', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const request = new Request('http://127.0.0.1/api/debug/upload?filename=large.bin', {
      method: 'POST',
      body: Uint8Array.from([0x00, 0xff]),
    });
    const clone = vi.spyOn(request, 'clone');

    try {
      const response = await traceAuthenticatedWebuiMutation(
        request,
        async () => new Response('{"status":"ok"}', {
          headers: { 'content-type': 'application/json' },
        }),
      );
      expect(await response.json()).toEqual({ status: 'ok' });
      expect(clone).not.toHaveBeenCalled();
      await waitForTerminal(entries);
    } finally {
      unsubscribe();
    }
  });

  it('reports an aborted streamed upload as cancelled even when the route returns 400', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const abort = new AbortController();
    const request = new Request('http://127.0.0.1/api/debug/upload?filename=cancelled.bin', {
      method: 'POST',
      body: Uint8Array.from([0x01]),
      signal: abort.signal,
    });

    try {
      abort.abort();
      const response = await traceAuthenticatedWebuiMutation(
        request,
        async () => new Response('{"status":"failed"}', { status: 400 }),
      );
      expect(response.status).toBe(400);
      const trace = await waitForTerminal(entries);
      expect(trace.at(-1)?.message).toMatch(
        /^webui_mutation_terminal outcome=cancelled reason=request_cancelled status=400 elapsedMs=\d+$/,
      );
    } finally {
      unsubscribe();
    }
  });

  it('keeps a non-abort streamed upload rejection as an HTTP failure', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const request = new Request('http://127.0.0.1/api/debug/upload?filename=too-large.bin', {
      method: 'POST',
      body: Uint8Array.from([0x01]),
    });

    try {
      await traceAuthenticatedWebuiMutation(
        request,
        async () => new Response('{"status":"failed"}', { status: 400 }),
      );
      const trace = await waitForTerminal(entries);
      expect(trace.at(-1)?.message).toMatch(
        /^webui_mutation_terminal outcome=failed reason=http_status status=400 elapsedMs=\d+$/,
      );
    } finally {
      unsubscribe();
    }
  });

  it('does not pull a streaming response ahead of the client', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    let pulls = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        pulls += 1;
        controller.enqueue(Uint8Array.from([pulls]));
        if (pulls === 2) controller.close();
      },
    }, { highWaterMark: 0 });

    try {
      const response = await traceAuthenticatedWebuiMutation(
        new Request('http://127.0.0.1/api/debug/invoke-stream', {
          method: 'POST',
          body: '{}',
        }),
        async () => new Response(stream),
      );

      await Promise.resolve();
      expect(pulls).toBe(0);
      expect(new Uint8Array(await response.arrayBuffer()))
        .toEqual(Uint8Array.from([0x01, 0x02]));
      await waitForTerminal(entries);
    } finally {
      unsubscribe();
    }
  });

  it('returns a streaming response before its body completes and traces completion later', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    let controller!: ReadableStreamDefaultController<Uint8Array>;
    const stream = new ReadableStream<Uint8Array>({
      start(value) {
        controller = value;
        value.enqueue(Uint8Array.from([0x01, 0x02]));
      },
    });

    try {
      const response = await traceAuthenticatedWebuiMutation(
        new Request('http://127.0.0.1/api/debug/invoke-stream', {
          method: 'POST',
          body: '{}',
        }),
        async () => new Response(stream, { status: 200 }),
      );

      expect(response.body).not.toBeNull();
      expect(mutationTrace(entries).some(
        (entry) => entry.message.startsWith('webui_mutation_terminal '),
      )).toBe(false);

      controller.enqueue(Uint8Array.from([0x03, 0x04]));
      controller.close();
      expect(new Uint8Array(await response.arrayBuffer()))
        .toEqual(Uint8Array.from([0x01, 0x02, 0x03, 0x04]));

      const trace = await waitForTerminal(entries);
      const responseChunks = trace.filter((entry) =>
        entry.message.includes('branch=response_chunk'));
      expect(responseChunks.map((entry) => entry.message)).toEqual([
        'webui_mutation_branch branch=response_chunk offset=0 length=2 body=0102',
        'webui_mutation_branch branch=response_chunk offset=2 length=2 body=0304',
      ]);
      expect(trace.every((entry) => entry.req === trace[0]!.req)).toBe(true);
      expect(trace.at(-1)?.message).toMatch(
        /^webui_mutation_terminal outcome=completed reason=response_completed status=200 elapsedMs=\d+$/,
      );
    } finally {
      unsubscribe();
    }
  });

  it('records one failed terminal when the traced response body cannot be read', async () => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const streamFailure = new Error('response stream exploded');
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(Uint8Array.from([0xaa]));
        controller.error(streamFailure);
      },
    });

    try {
      const response = await traceAuthenticatedWebuiMutation(
        new Request('http://127.0.0.1/api/debug/invoke-stream', {
          method: 'POST',
          body: '{}',
        }),
        async () => new Response(stream),
      );
      await expect(response.arrayBuffer()).rejects.toBe(streamFailure);

      const trace = await waitForTerminal(entries);
      expect(trace.some((entry) =>
        entry.message.includes('branch=request_body')
        && entry.message.includes('body=7b7d'))).toBe(true);
      expect(trace.at(-1)?.message).toMatch(
        /^webui_mutation_terminal outcome=failed reason=body_read_failed status=200 error="response stream exploded" elapsedMs=\d+$/,
      );
      expect(trace.filter((entry) => entry.message.startsWith('webui_mutation_terminal ')))
        .toHaveLength(1);
    } finally {
      unsubscribe();
    }
  });

  it.each([
    ['GET', '/api/config/12345'],
    ['HEAD', '/api/config/12345'],
    ['OPTIONS', '/api/config/12345'],
    ['POST', '/api/auth/check-strength'],
    ['POST', '/api/logs/level'],
  ])('keeps %s %s outside mutation TRACE', async (method, pathname) => {
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const request = new Request(`http://127.0.0.1${pathname}`, { method });
    const clone = vi.spyOn(request, 'clone');

    try {
      await traceAuthenticatedWebuiMutation(request, async () => new Response(null, { status: 204 }));
      expect(clone).not.toHaveBeenCalled();
      expect(mutationTrace(entries)).toEqual([]);
    } finally {
      unsubscribe();
    }
  });
});
