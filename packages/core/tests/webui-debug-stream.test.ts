import { describe, it, expect } from 'vitest';
import { createFramePusher } from '../src/webui/debug-stream';

function harness(sizes: number[]) {
  // desiredSize() returns the next scripted value each call.
  let i = 0;
  const frames: string[] = [];
  const push = createFramePusher({
    desiredSize: () => (i < sizes.length ? sizes[i++] : sizes[sizes.length - 1] ?? 1),
    enqueue: (chunk) => { frames.push(Buffer.from(chunk).toString()); },
    encode: (s) => Buffer.from(s),
  });
  return { push, frames };
}

describe('createFramePusher', () => {
  it('enqueues an SSE data frame when there is headroom', () => {
    const { push, frames } = harness([1]);
    push({ kind: 'event', x: 1 });
    expect(frames).toEqual([`data: ${JSON.stringify({ kind: 'event', x: 1 })}\n\n`]);
  });

  it('drops under backpressure (desiredSize <= 0) without enqueuing', () => {
    const { push, frames } = harness([0, -3]);
    push({ a: 1 });
    push({ a: 2 });
    expect(frames).toEqual([]);
  });

  it('emits a coalesced dropped marker before the next delivered frame', () => {
    const { push, frames } = harness([0, 0, 5]); // drop, drop, then headroom
    push({ a: 1 });
    push({ a: 2 });
    push({ a: 3 });
    expect(frames).toEqual([
      `data: ${JSON.stringify({ kind: 'dropped', count: 2 })}\n\n`,
      `data: ${JSON.stringify({ a: 3 })}\n\n`,
    ]);
  });

  it('treats null desiredSize as always-deliver (no backpressure signal)', () => {
    let i = 0;
    const frames: string[] = [];
    const push = createFramePusher({
      desiredSize: () => (i++ === 0 ? null : 1),
      enqueue: (chunk) => { frames.push(Buffer.from(chunk).toString()); },
      encode: (s) => Buffer.from(s),
    });
    push({ a: 1 });
    expect(frames).toHaveLength(1);
  });
});
