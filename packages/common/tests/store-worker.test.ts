import { afterEach, describe, expect, it } from 'vitest';
import { closeStoreWorkers, configureStoreWorkers, StoreWorkerClient } from '../src/store-worker';
import { runWithRequestId, subscribeLogs, type LogEntry } from '../src/logger';

const program = `
const { parentPort } = require('node:worker_threads');
const stores = new Map();
parentPort.on('message', r => {
  try {
    let value;
    if (r.operation === 'open') {
      if (r.kind === 'bad') throw new Error('open failed');
      stores.set(r.id, []);
    } else if (r.operation === 'close') stores.delete(r.id);
    else if (r.method === 'append') { stores.get(r.id).push(r.args[0]); value = stores.get(r.id); }
    else if (r.method === 'block') {
      const gate = new Int32Array(r.args[0]);
      Atomics.store(gate, 0, 1);
      Atomics.notify(gate, 0);
      Atomics.wait(gate, 1, 0, 2000);
    } else if (r.method === 'log') {
      parentPort.postMessage({ type: 'log', record: { level: 'warn', scope: 'Store.Test', uin: 10001, req: r.trace, message: 'store warning' } });
    } else if (r.method === 'ping') value = r.args[0];
    else if (r.method === 'crash') process.exit(9);
    else throw new Error('method failed');
    parentPort.postMessage({ requestId: r.requestId, value });
  } catch(e) { parentPort.postMessage({ requestId: r.requestId, error: { name: e.name, message: e.message } }); }
});
`;

afterEach(async () => { await closeStoreWorkers(); });

describe('store workers', () => {
  it('keeps the main timer responsive while its store is synchronously blocked', async () => {
    configureStoreWorkers(program);
    const client = new StoreWorkerClient('one', 'test', []);
    const gate = new Int32Array(new SharedArrayBuffer(8));
    const blocked = client.call('block', [gate.buffer]);
    await new Promise<void>((resolve, reject) => {
      const deadline = Date.now() + 1500;
      const timer = setInterval(() => {
        if (Atomics.load(gate, 0) === 1) { clearInterval(timer); resolve(); }
        else if (Date.now() > deadline) { clearInterval(timer); reject(new Error('worker did not start')); }
      }, 5);
    });
    const other = new StoreWorkerClient('two', 'test', []);
    const ticks: number[] = [];
    const timer = setInterval(() => ticks.push(Date.now()), 10);
    try {
      expect(await other.call('append', ['other account'])).toEqual(['other account']);
      await new Promise(resolve => setTimeout(resolve, 60));
      expect(ticks.length).toBeGreaterThanOrEqual(3);
    } finally {
      clearInterval(timer);
      Atomics.store(gate, 1, 1); Atomics.notify(gate, 1);
      await blocked;
    }
  });

  it('captures input and drains accepted calls before close, rejecting later work', async () => {
    configureStoreWorkers(program);
    const client = new StoreWorkerClient('one', 'test', []);
    const input = { text: 'accepted' };
    const first = client.call('append', [input]);
    input.text = 'changed';
    const second = client.call('append', ['second']);
    const closing = client.close();
    await expect(client.call('append', ['late'])).rejects.toThrow('closing');
    expect(await first).toEqual([{ text: 'accepted' }]);
    expect(await second).toEqual([{ text: 'accepted' }, 'second']);
    await closing;
    await client.close();
  });

  it('returns method failures without breaking the next request', async () => {
    configureStoreWorkers(program);
    const client = new StoreWorkerClient('one', 'test', []);
    await expect(client.call('invalid')).rejects.toThrow('method failed');
    expect(await client.call('append', ['ok'])).toEqual(['ok']);
    await expect(client.call('append', [() => undefined])).rejects.toThrow();
  });

  it('reports opening and worker-exit failures and releases the failed pool', async () => {
    configureStoreWorkers(program);
    const bad = new StoreWorkerClient('bad', 'bad', []);
    await expect(bad.call('append', ['x'])).rejects.toThrow('open failed');
    await expect(bad.close()).rejects.toThrow('open failed');
    const dead = new StoreWorkerClient('one', 'test', []);
    await expect(dead.call('crash')).rejects.toThrow('exited unexpectedly');
    await expect(dead.call('append', ['x'])).rejects.toThrow('exited unexpectedly');
    await expect(dead.close()).rejects.toThrow('exited unexpectedly');
    configureStoreWorkers(program);
    const next = new StoreWorkerClient('one', 'test', []);
    expect(await next.call('append', ['new'])).toEqual(['new']);
  });

  it('returns worker logs through the normal logger with account and request context', async () => {
    configureStoreWorkers(program);
    const client = new StoreWorkerClient('one', 'test', []);
    const entries: LogEntry[] = [];
    const unsubscribe = subscribeLogs(entry => entries.push(entry));
    try { await runWithRequestId(123, () => client.call('log')); }
    finally { unsubscribe(); }
    expect(entries).toContainEqual(expect.objectContaining({ scope: 'Store.Test', level: 'warn', uin: 10001, req: 123, message: 'store warning' }));
  });

  it('rejects excess queue work while draining every accepted request', async () => {
    configureStoreWorkers(program);
    const client = new StoreWorkerClient('one', 'test', []);
    const calls = Array.from({ length: 2048 }, (_, i) => client.call<number>('ping', [i]));
    await expect(client.call('ping', ['overflow'])).rejects.toThrow('queue is full');
    const closing = client.close();
    expect(await Promise.all(calls)).toEqual(Array.from({ length: 2048 }, (_, i) => i));
    await closing;
  });
});
