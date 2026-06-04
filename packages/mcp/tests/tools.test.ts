import { describe, it, expect } from 'vitest';
import { computeTools, callTool } from '../src/tools';
import type { ActionClient, OneBotEnvelope } from '../src/client';

type Res = Awaited<ReturnType<typeof callTool>>;
function text(res: Res): string {
  const block = res.content?.[0];
  return block && block.type === 'text' ? block.text : '';
}
function parsed(res: Res): any {
  return JSON.parse(text(res));
}

/** A fake ActionClient — no transport. Records the last call and returns a
 *  canned envelope (overridable per test). */
function fakeClient(impl?: (action: string, params: Record<string, unknown>) => OneBotEnvelope): ActionClient {
  return {
    call: async (action, params) => impl?.(action, params) ?? { status: 'ok', retcode: 0, data: { action, params } },
  };
}

describe('computeTools — mode gating', () => {
  it('docs mode exposes only the 4 catalog tools', () => {
    expect(computeTools('docs').map((t) => t.name)).toEqual([
      'list_actions', 'get_action', 'search_actions', 'list_categories',
    ]);
  });
  it('read mode adds query_action only (no invoke_action)', () => {
    const names = computeTools('read').map((t) => t.name);
    expect(names).toContain('query_action');
    expect(names).not.toContain('invoke_action');
  });
  it('write mode adds both query_action and invoke_action', () => {
    const names = computeTools('write').map((t) => t.name);
    expect(names).toContain('query_action');
    expect(names).toContain('invoke_action');
  });
  it('annotations are honest: query=readOnly, invoke=destructive', () => {
    const q = computeTools('write').find((t) => t.name === 'query_action');
    const inv = computeTools('write').find((t) => t.name === 'invoke_action');
    expect(q?.annotations?.readOnlyHint).toBe(true);
    expect(inv?.annotations?.readOnlyHint).toBe(false);
    expect(inv?.annotations?.destructiveHint).toBe(true);
  });
});

describe('callTool — docs tools (no client needed)', () => {
  it('list_actions returns entries that carry readOnly', async () => {
    const data = parsed(await callTool('list_actions', {}, { mode: 'docs' }));
    expect(data.count).toBeGreaterThan(100);
    expect(typeof data.actions[0].readOnly).toBe('boolean');
  });
  it('get_action resolves a known read-only action', async () => {
    const a = parsed(await callTool('get_action', { name: 'get_status' }, { mode: 'docs' }));
    expect(a.name).toBe('get_status');
    expect(a.readOnly).toBe(true);
  });
  it('get_action on a write action reports readOnly=false', async () => {
    expect(parsed(await callTool('get_action', { name: 'send_group_msg' }, { mode: 'docs' })).readOnly).toBe(false);
  });
  it('get_action accepts an alias', async () => {
    // nc_get_rkey is an alias of get_rkey (read-only).
    const a = parsed(await callTool('get_action', { name: 'nc_get_rkey' }, { mode: 'docs' }));
    expect(a.name).toBe('get_rkey');
  });
});

describe('callTool — query_action (read)', () => {
  it('executes a read-only action and passes the envelope through', async () => {
    const res = await callTool('query_action', { action: 'get_status', params: {} }, { mode: 'read', client: fakeClient() });
    expect(res.isError).toBeFalsy();
    expect(parsed(res).retcode).toBe(0);
  });
  it('refuses a write action and points to invoke_action', async () => {
    const res = await callTool('query_action', { action: 'send_group_msg', params: {} }, { mode: 'read', client: fakeClient() });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('invoke_action');
  });
  it('refuses an unknown action', async () => {
    const res = await callTool('query_action', { action: 'no_such_action' }, { mode: 'read', client: fakeClient() });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('未知 action');
  });
  it('is blocked in docs mode even when called directly (defense in depth)', async () => {
    const res = await callTool('query_action', { action: 'get_status' }, { mode: 'docs' });
    expect(res.isError).toBe(true);
  });
  it('errors clearly when no client is wired', async () => {
    const res = await callTool('query_action', { action: 'get_status' }, { mode: 'read' });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('未配置');
  });
});

describe('callTool — invoke_action (write)', () => {
  it('executes a write action in write mode and forwards action+params', async () => {
    let seen: { action: string; params: Record<string, unknown> } | null = null;
    const client: ActionClient = {
      call: async (action, params) => {
        seen = { action, params };
        return { status: 'ok', retcode: 0, data: { message_id: 42 } };
      },
    };
    const res = await callTool('invoke_action', { action: 'send_group_msg', params: { group_id: 1, message: 'hi' } }, { mode: 'write', client });
    expect(res.isError).toBeFalsy();
    expect(seen!.action).toBe('send_group_msg');
    expect(seen!.params).toEqual({ group_id: 1, message: 'hi' });
    expect(parsed(res).data.message_id).toBe(42);
  });
  it('is blocked in read mode (write gate cannot be bypassed)', async () => {
    const res = await callTool('invoke_action', { action: 'send_group_msg', params: {} }, { mode: 'read', client: fakeClient() });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('写操作未启用');
  });
  it('passes a retcode≠0 envelope through as data, NOT isError', async () => {
    const client = fakeClient(() => ({ status: 'failed', retcode: 1404, message: 'not found', wording: '未找到' }));
    const res = await callTool('invoke_action', { action: 'send_group_msg', params: {} }, { mode: 'write', client });
    expect(res.isError).toBeFalsy();
    expect(parsed(res).retcode).toBe(1404);
    expect(parsed(res).wording).toBe('未找到');
  });
  it('maps a transport-level throw to isError', async () => {
    const client: ActionClient = { call: async () => { throw new Error('connection refused'); } };
    const res = await callTool('invoke_action', { action: 'send_group_msg', params: {} }, { mode: 'write', client });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('调用失败');
    expect(text(res)).toContain('connection refused');
  });
  it('accepts a read-only action too (invoke is a superset)', async () => {
    const res = await callTool('invoke_action', { action: 'get_status', params: {} }, { mode: 'write', client: fakeClient() });
    expect(res.isError).toBeFalsy();
  });
  it('refuses an unknown action (typo safety)', async () => {
    const res = await callTool('invoke_action', { action: 'frobnicate' }, { mode: 'write', client: fakeClient() });
    expect(res.isError).toBe(true);
    expect(text(res)).toContain('未知 action');
  });
});
