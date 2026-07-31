import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import { defineStreamAction } from '../src/action-kit';
import {
  currentRequestId,
  getLogLevel,
  nextRequestId,
  runWithRequestId,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import { StreamTransportClosedError, StreamStatus } from '../src/streaming';
import type { JsonObject } from '../src/types';
import { createCompiledTestHandler, testAction } from './helpers/compiled-action-handler';

function emptyContext(): any {
  return {};
}

function actionEntries(entries: LogEntry[], action: string): LogEntry[] {
  return entries.filter((entry) => (
    entry.scope === 'Bridge.Action'
    && entry.level === 'trace'
    && entry.message.includes(`action=${action}`)
  ));
}

describe('ApiHandler TRACE lifecycle', () => {
  let previousLevel: string;
  let entries: LogEntry[];
  let unsubscribe: () => void;

  beforeEach(() => {
    previousLevel = getLogLevel();
    setLogLevel('trace');
    entries = [];
    unsubscribe = subscribeLogs((entry) => entries.push(entry));
  });

  afterEach(() => {
    unsubscribe();
    setLogLevel(previousLevel);
  });

  it('records complete input and returned response with one terminal', async () => {
    const secret = 'trace-secret-' + 'x'.repeat(200);
    const handler = createCompiledTestHandler(emptyContext(), [
      testAction('trace_ok', async () => ({
        status: 'ok',
        retcode: 0,
        data: { nested: { secret, values: [1, 2, 3] } },
      })),
    ]);

    await handler.handle('trace_ok', { nested: { access_token: secret } });

    const lifecycle = actionEntries(entries, 'trace_ok');
    expect(lifecycle.filter((entry) => entry.message.startsWith('action_input'))).toHaveLength(1);
    expect(lifecycle.filter((entry) => entry.message.startsWith('action_terminal'))).toHaveLength(1);
    expect(lifecycle[0]?.message).toContain(secret);
    expect(lifecycle.at(-1)?.message).toContain(secret);
    expect(lifecycle.at(-1)?.message).toContain('outcome=ok');
    expect(lifecycle.at(-1)?.message).toContain('reason=response_returned');
    expect(new Set(lifecycle.map((entry) => entry.req)).size).toBe(1);
    expect(lifecycle[0]?.req).toBeTypeOf('number');
  });

  it('distinguishes returned failure, handler throw, unknown action, and quiesce', async () => {
    const handler = createCompiledTestHandler(emptyContext(), [
      testAction('returned_failure', async () => ({
        status: 'failed', retcode: 1400, data: null, wording: 'invalid input',
      })),
      testAction('thrown_failure', async () => { throw new Error('exploded'); }),
    ]);

    await handler.handle('returned_failure', {});
    await handler.handle('thrown_failure', {});
    await handler.handle('unknown_trace_action', {});
    handler.quiesce();
    await handler.handle('returned_failure', {});

    const returned = actionEntries(entries, 'returned_failure')
      .filter((entry) => entry.message.startsWith('action_terminal'));
    expect(returned[0]?.message).toContain('outcome=failed reason=response_returned');
    expect(returned[0]?.message).toContain('wording:"invalid input"');
    expect(returned[1]?.message).toContain('outcome=failed reason=quiesced');

    const thrown = actionEntries(entries, 'thrown_failure')
      .filter((entry) => entry.message.startsWith('action_terminal'));
    expect(thrown).toHaveLength(1);
    expect(thrown[0]?.message).toContain('outcome=failed reason=handler_threw');
    expect(thrown[0]?.message).toContain('wording:"exploded"');

    const unknown = actionEntries(entries, 'unknown_trace_action')
      .filter((entry) => entry.message.startsWith('action_terminal'));
    expect(unknown).toHaveLength(1);
    expect(unknown[0]?.message).toContain('outcome=failed reason=unknown_action');
  });

  it('records parsed transport rejections without executing actions or observers', () => {
    const run = vi.fn(async () => ({ status: 'ok' as const, retcode: 0, data: null }));
    const observer = vi.fn();
    const handler = createCompiledTestHandler(emptyContext(), [
      testAction('transport_quiesced', run),
    ]);
    handler.setObserver(observer);
    handler.quiesce();

    handler.traceQuiescedStreamRequest(JSON.stringify({
      action: 'transport_quiesced',
      params: { access_token: 'complete-secret' },
      echo: 'not-part-of-params',
    }));
    handler.traceQuiescedStreamRequest('not json');
    handler.traceQuiescedStreamRequest(JSON.stringify({ params: {} }));

    const lifecycle = actionEntries(entries, 'transport_quiesced');
    expect(lifecycle).toHaveLength(2);
    expect(lifecycle[0]?.message).toContain('action_input');
    expect(lifecycle[0]?.message).toContain('complete-secret');
    expect(lifecycle[0]?.message).not.toContain('not-part-of-params');
    expect(lifecycle[1]?.message).toContain('outcome=failed reason=quiesced');
    expect(new Set(lifecycle.map((entry) => entry.req)).size).toBe(1);
    expect(run).not.toHaveBeenCalled();
    expect(observer).not.toHaveBeenCalled();
  });

  it('ignores transport-rejection tracing while actions are still accepted', () => {
    const handler = createCompiledTestHandler(emptyContext(), [
      testAction('still_accepting', async () => ({ status: 'ok', retcode: 0, data: null })),
    ]);

    handler.traceQuiescedStreamRequest(JSON.stringify({
      action: 'still_accepting',
      params: {},
    }));

    expect(actionEntries(entries, 'still_accepting')).toHaveLength(0);
  });

  it('records successful stream frames and classifies transport closure only', async () => {
    const stream = defineStreamAction({
      name: 'trace_stream',
      params: {},
      run: async (_params, _ctx, _raw, sink) => {
        await sink.send({ type: StreamStatus.Stream, chunk: 'complete-frame' });
        return {
          status: 'ok',
          retcode: 0,
          data: { type: StreamStatus.Response },
        };
      },
    });
    const handler = createCompiledTestHandler(emptyContext(), [stream]);

    await handler.handle('trace_stream', {}, { send: async () => {} });
    const frames = actionEntries(entries, 'trace_stream')
      .filter((entry) => entry.message.startsWith('action_stream_frame'));
    expect(frames).toHaveLength(1);
    expect(frames[0]?.message).toContain('complete-frame');

    entries = [];
    await handler.handle('trace_stream', {}, {
      send: async () => { throw new StreamTransportClosedError(); },
    });
    const cancelled = actionEntries(entries, 'trace_stream')
      .filter((entry) => entry.message.startsWith('action_terminal'));
    expect(cancelled).toHaveLength(1);
    expect(cancelled[0]?.message).toContain('outcome=cancelled reason=transport_closed');
    expect(actionEntries(entries, 'trace_stream')
      .filter((entry) => entry.message.startsWith('action_stream_frame'))).toHaveLength(1);

    entries = [];
    await handler.handle('trace_stream', {}, {
      send: async () => { throw new Error('arbitrary sink failure'); },
    });
    const failed = actionEntries(entries, 'trace_stream')
      .filter((entry) => entry.message.startsWith('action_terminal'));
    expect(failed).toHaveLength(1);
    expect(failed[0]?.message).toContain('outcome=failed reason=handler_threw');
  });

  it('reuses an ambient request and gives separate top-level actions separate ids', async () => {
    let handler: ReturnType<typeof createCompiledTestHandler>;
    handler = createCompiledTestHandler(emptyContext(), [
      testAction('inner_trace', async () => ({ status: 'ok', retcode: 0, data: null })),
      testAction('outer_trace', async () => {
        await handler.handle('inner_trace', {});
        return { status: 'ok', retcode: 0, data: null };
      }),
    ]);

    await handler.handle('outer_trace', {});
    const nested = [
      ...actionEntries(entries, 'outer_trace'),
      ...actionEntries(entries, 'inner_trace'),
    ];
    expect(new Set(nested.map((entry) => entry.req)).size).toBe(1);

    entries = [];
    await handler.handle('inner_trace', {});
    await handler.handle('inner_trace', {});
    const topLevelInputs = actionEntries(entries, 'inner_trace')
      .filter((entry) => entry.message.startsWith('action_input'));
    expect(topLevelInputs).toHaveLength(2);
    expect(topLevelInputs[0]?.req).not.toBe(topLevelInputs[1]?.req);

    entries = [];
    await runWithRequestId(424242, () => handler.handle('inner_trace', {}));
    expect(actionEntries(entries, 'inner_trace').every((entry) => entry.req === 424242)).toBe(true);
  });

  it('does not allocate a request or render the complete object while TRACE is disabled', async () => {
    setLogLevel('info');
    const nested: JsonObject = {};
    Object.defineProperty(nested, 'danger', {
      enumerable: true,
      get: () => { throw new Error('verbose renderer ran'); },
    });
    const handler = createCompiledTestHandler(emptyContext(), [
      testAction('trace_off', async () => ({ status: 'ok', retcode: 0, data: null })),
    ]);
    const before = nextRequestId();

    await expect(handler.handle('trace_off', { nested })).resolves.toMatchObject({ status: 'ok' });

    const after = nextRequestId();
    expect(after).toBe(before + 1);
    expect(currentRequestId()).toBeUndefined();
    expect(actionEntries(entries, 'trace_off')).toHaveLength(0);
  });
});
