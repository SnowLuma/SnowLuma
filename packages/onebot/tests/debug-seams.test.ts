import { describe, it, expect, vi } from 'vitest';
import { OneBotNetworkManager } from '../src/network/network-manager';
import { ApiHandler, type ApiActionContext } from '../src/api-handler';

// ApiHandler's register* only define handlers (closures) at construction — they
// don't touch ctx — so a throwing proxy is a safe minimal context.
function fakeCtx(): ApiActionContext {
  return new Proxy({} as ApiActionContext, {
    get(_t, prop) { throw new Error(`ctx.${String(prop)} not stubbed`); },
  });
}

describe('OneBotNetworkManager.subscribeDebug', () => {
  it('notifies debug subscribers on emitEvent even with no active adapters', async () => {
    const nm = new OneBotNetworkManager();
    const seen: unknown[] = [];
    nm.subscribeDebug((e) => seen.push(e));
    await nm.emitEvent({ post_type: 'meta_event', x: 1 });
    expect(seen).toEqual([{ post_type: 'meta_event', x: 1 }]);
  });

  it('stops notifying after unsubscribe', async () => {
    const nm = new OneBotNetworkManager();
    const cb = vi.fn();
    const off = nm.subscribeDebug(cb);
    await nm.emitEvent({ a: 1 });
    off();
    await nm.emitEvent({ a: 2 });
    expect(cb).toHaveBeenCalledTimes(1);
    expect(cb).toHaveBeenCalledWith({ a: 1 });
  });

  it('a throwing subscriber does not break emitEvent', async () => {
    const nm = new OneBotNetworkManager();
    nm.subscribeDebug(() => { throw new Error('boom'); });
    await expect(nm.emitEvent({ a: 1 })).resolves.toBeUndefined();
  });
});

describe('ApiHandler.setObserver', () => {
  it('fires after a successful action with {action, params, response, ms}', async () => {
    const h = new ApiHandler(fakeCtx());
    h.registerAction('ping', async () => ({ status: 'ok', retcode: 0, data: 'pong' }));
    const recs: Array<{ action: string; response: { status: string } }> = [];
    h.setObserver((r) => recs.push(r as any));
    const res = await h.handle('ping', { x: 1 });
    expect(res).toMatchObject({ status: 'ok', data: 'pong' });
    expect(recs).toHaveLength(1);
    expect(recs[0]).toMatchObject({ action: 'ping', params: { x: 1 }, response: { status: 'ok' } });
    expect(typeof (recs[0] as any).ms).toBe('number');
  });

  it('fires on a thrown action with the failure response', async () => {
    const h = new ApiHandler(fakeCtx());
    h.registerAction('boom', async () => { throw new Error('kaboom'); });
    const recs: any[] = [];
    h.setObserver((r) => recs.push(r));
    await h.handle('boom', {});
    expect(recs).toHaveLength(1);
    expect(recs[0].response.status).toBe('failed');
  });

  it('unsubscribe stops observation', async () => {
    const h = new ApiHandler(fakeCtx());
    h.registerAction('ping', async () => ({ status: 'ok', retcode: 0 }));
    const cb = vi.fn();
    const off = h.setObserver(cb);
    await h.handle('ping', {});
    off();
    await h.handle('ping', {});
    expect(cb).toHaveBeenCalledTimes(1);
  });

  it('a throwing observer does not break handle', async () => {
    const h = new ApiHandler(fakeCtx());
    h.registerAction('ping', async () => ({ status: 'ok', retcode: 0 }));
    h.setObserver(() => { throw new Error('observer boom'); });
    await expect(h.handle('ping', {})).resolves.toMatchObject({ status: 'ok' });
  });
});
