// Phase 1 — Stream API plumbing (#163). Verifies the dispatch seam:
// defineStreamAction registers a streaming handler, processStreamRequest
// emits N intermediate frames + a terminal frame (all echo-tagged, marked
// `stream:'stream-action'`), normal actions stay single-frame, and failures
// terminate with an error frame. Wire format mirrors NapCat's Stream API.
import { describe, it, expect } from 'vitest';
import type { ApiHandler, ApiActionContext } from '../src/api-handler';
import { defineAction, defineStreamAction, f, type RegisteredActionSpec } from '../src/action-kit';
import { okResponse, failedResponse } from '../src/types';
import { wrapStreamFrame, wrapStreamTerminal, STREAM_MARK } from '../src/streaming';
import { createCompiledTestHandler } from './helpers/compiled-action-handler';

function newHandler(...specs: RegisteredActionSpec[]): ApiHandler {
  // ActionSpecs bind during the constructor but call ctx only when dispatched.
  return createCompiledTestHandler({} as ApiActionContext, specs);
}

const parse = (frames: string[]) => frames.map((f) => JSON.parse(f) as Record<string, unknown>);

describe('Stream API plumbing', () => {
  it('streams N intermediate frames + a terminal frame, all echo-tagged', async () => {
    const action = defineStreamAction({
      name: 'demo_stream',
      params: { n: f.uint() },
      run: async (p, _ctx, sink) => {
        for (let i = 0; i < p.n; i++) await sink.send({ type: 'stream', index: i });
        return okResponse({ type: 'response', total: p.n });
      },
    });
    const h = newHandler(action);

    const frames: string[] = [];
    await h.processStreamRequest(
      JSON.stringify({ action: 'demo_stream', params: { n: 2 }, echo: 'e1' }),
      (j) => frames.push(j),
    );

    const got = parse(frames);
    expect(got).toHaveLength(3);
    expect(got[0]).toMatchObject({ status: 'ok', retcode: 0, stream: STREAM_MARK, echo: 'e1', data: { type: 'stream', index: 0 } });
    expect(got[1]).toMatchObject({ stream: STREAM_MARK, echo: 'e1', data: { type: 'stream', index: 1 } });
    expect(got[2]).toMatchObject({ status: 'ok', stream: STREAM_MARK, echo: 'e1', data: { type: 'response', total: 2 } });
  });

  it('marks the action as a stream action; normal actions are not', () => {
    const streamAction = defineStreamAction({ name: 'demo_stream', params: {}, run: () => okResponse({ type: 'response' }) });
    const normalAction = defineAction({ name: 'demo_normal', params: {}, run: () => okResponse({ ok: true }) });
    const h = newHandler(streamAction, normalAction);
    expect(h.isStreamAction('demo_stream')).toBe(true);
    expect(h.isStreamAction('demo_normal')).toBe(false);
    expect(h.isStreamAction('nope')).toBe(false);
  });

  it('a normal action through processStreamRequest emits exactly one un-marked frame', async () => {
    const action = defineAction({ name: 'demo_normal', params: {}, run: () => okResponse({ ok: true }) });
    const h = newHandler(action);

    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'demo_normal', params: {}, echo: 'e2' }), (j) => frames.push(j));

    expect(frames).toHaveLength(1);
    const r = parse(frames)[0];
    expect(r).toMatchObject({ status: 'ok', echo: 'e2', data: { ok: true } });
    expect(r.stream).toBeUndefined();
  });

  it('a throwing stream action terminates with a single error frame', async () => {
    const action = defineStreamAction({
      name: 'demo_boom',
      params: {},
      run: async () => { throw new Error('boom'); },
    });
    const h = newHandler(action);

    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'demo_boom', params: {}, echo: 'e3' }), (j) => frames.push(j));

    expect(frames).toHaveLength(1);
    expect(parse(frames)[0]).toMatchObject({
      status: 'failed', stream: STREAM_MARK, echo: 'e3', wording: 'boom', data: { type: 'error', data_type: 'error' },
    });
  });

  it('emits already-sent frames before the terminal error when a stream throws mid-way', async () => {
    const action = defineStreamAction({
      name: 'demo_partial',
      params: {},
      run: async (_p, _ctx, sink) => {
        await sink.send({ type: 'stream', index: 0 });
        throw new Error('mid');
      },
    });
    const h = newHandler(action);

    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'demo_partial', params: {} }), (j) => frames.push(j));

    const got = parse(frames);
    expect(got).toHaveLength(2);
    expect(got[0]).toMatchObject({ stream: STREAM_MARK, data: { type: 'stream', index: 0 } });
    expect(got[1]).toMatchObject({ status: 'failed', data: { type: 'error' } });
  });

  it('stream param validation fails terminate with an error frame', async () => {
    const action = defineStreamAction({ name: 'demo_needs', params: { n: f.uint() }, run: () => okResponse({ type: 'response' }) });
    const h = newHandler(action);

    const frames: string[] = [];
    await h.processStreamRequest(JSON.stringify({ action: 'demo_needs', params: {} }), (j) => frames.push(j));
    expect(frames).toHaveLength(1);
    expect(parse(frames)[0]).toMatchObject({ status: 'failed', stream: STREAM_MARK, data: { type: 'error' } });
  });

  it('aborts a stream when isAlive turns false (client disconnect)', async () => {
    let sent = 0;
    const action = defineStreamAction({
      name: 'demo_abort',
      params: {},
      run: async (_p, _ctx, sink) => {
        for (let i = 0; i < 5; i++) { await sink.send({ type: 'stream', index: i }); sent++; }
        return okResponse({ type: 'response' });
      },
    });
    const h = newHandler(action);

    const frames: string[] = [];
    let alive = true;
    await h.processStreamRequest(
      JSON.stringify({ action: 'demo_abort', params: {} }),
      (j) => { frames.push(j); if (frames.length >= 2) alive = false; },
      () => alive,
    );

    expect(sent).toBeLessThan(5); // loop aborted once the client "left"
    const got = parse(frames);
    expect(got[got.length - 1]).toMatchObject({ status: 'failed', data: { type: 'error' } });
  });

  it('wrapStreamFrame / wrapStreamTerminal shape (NapCat message+wording mirror)', () => {
    expect(wrapStreamFrame({ type: 'stream', x: 1 }, 'e')).toEqual({
      status: 'ok', retcode: 0, data: { type: 'stream', x: 1 }, message: '', wording: '', stream: STREAM_MARK, echo: 'e',
    });
    // no echo → no echo key
    expect(wrapStreamFrame({ type: 'stream' }, undefined)).toEqual({
      status: 'ok', retcode: 0, data: { type: 'stream' }, message: '', wording: '', stream: STREAM_MARK,
    });
    // failed terminal → data normalised to an error packet; reason in BOTH message + wording
    expect(wrapStreamTerminal(failedResponse(1404, 'nope'), 'e')).toMatchObject({
      status: 'failed', retcode: 1404, message: 'nope', wording: 'nope', stream: STREAM_MARK, echo: 'e',
      data: { type: 'error', data_type: 'error' },
    });
    // ok terminal → data passes through, message/wording empty
    expect(wrapStreamTerminal(okResponse({ type: 'response', a: 1 }), undefined)).toMatchObject({
      status: 'ok', stream: STREAM_MARK, message: '', data: { type: 'response', a: 1 },
    });
  });

  it('malformed stream requests emit one bad-request frame', async () => {
    const h = newHandler();
    const frames: string[] = [];
    await h.processStreamRequest('not json', (j) => frames.push(j));
    await h.processStreamRequest('', (j) => frames.push(j));
    await h.processStreamRequest(JSON.stringify({ params: {} }), (j) => frames.push(j)); // no action
    expect(frames).toHaveLength(3);
    for (const f of parse(frames)) expect(f).toMatchObject({ status: 'failed' });
  });

  it('waits for an async bad-request frame to flush', async () => {
    const h = newHandler();
    let release!: () => void;
    const flushed = new Promise<void>((resolve) => { release = resolve; });
    let completed = false;

    const request = h.processStreamRequest('', async () => flushed);
    void request.then(() => { completed = true; });
    await Promise.resolve();
    expect(completed).toBe(false);

    release();
    await request;
    expect(completed).toBe(true);
  });
});
