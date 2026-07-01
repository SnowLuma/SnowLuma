// Tests for ApiHandler's central dispatch logging.
// Verifies that every action call emits a debug entry line, failures
// fold into a warn line with stack, and unknown actions are surfaced.
// Also covers the summarizeParams helper used to keep the entry log
// from blowing the line width.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { ApiHandler } from '../src/api-handler';
import { OidbError } from '@snowluma/protocol/oidb-service';
import { subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import { summarizeParams } from '@snowluma/common/log-summary';

// Minimal context — we never reach the real action handlers; we
// register our own via registerAction.
function emptyContext(): any {
  return {
    bridge: {},
    getLoginInfo: () => ({ userId: 0, nickname: '' }),
    isOnline: () => true,
    getMessage: () => null,
    getMessageMeta: () => null,
    sendPrivateMessage: async () => ({ messageId: 0 }),
    sendGroupMessage: async () => ({ messageId: 0 }),
    deleteMessage: async () => {},
    canSendImage: () => true,
    canSendRecord: () => true,
    getFriendList: async () => [],
    getImageInfo: async () => null,
    getRecordInfo: async () => null,
  };
}

let captured: LogEntry[];
let unsub: () => void;
const savedLogLevel = process.env.SNOWLUMA_LOG_LEVEL;

beforeEach(() => {
  process.env.SNOWLUMA_LOG_LEVEL = 'debug';
  captured = [];
  unsub = subscribeLogs((e) => captured.push(e));
});

afterEach(() => {
  unsub();
  if (savedLogLevel === undefined) delete process.env.SNOWLUMA_LOG_LEVEL;
  else process.env.SNOWLUMA_LOG_LEVEL = savedLogLevel;
});

describe('summarizeParams', () => {
  it('renders flat scalar fields as k=v pairs', () => {
    const out = summarizeParams({ group_id: 12345, auto_escape: false, foo: 'bar' });
    expect(out).toBe('group_id=12345 auto_escape=false foo="bar"');
  });

  it('truncates long string values with an ellipsis', () => {
    const long = 'x'.repeat(80);
    const out = summarizeParams({ s: long });
    expect(out).toMatch(/^s="x{40}\.\.\."$/);
  });

  it('collapses arrays and nested objects rather than dumping them', () => {
    const out = summarizeParams({ messages: [1, 2, 3, 4], meta: { a: 1, b: 2 } });
    expect(out).toBe('messages=[len=4] meta={...}');
  });

  it('caps the total line and tags the cut with ellipsis', () => {
    const params: Record<string, number> = {};
    for (let i = 0; i < 30; i++) params[`field_with_some_padding_${i}`] = i;
    const out = summarizeParams(params);
    expect(out.length).toBeLessThan(220);
    expect(out.endsWith('...')).toBe(true);
  });

  it('handles null / undefined inputs gracefully', () => {
    expect(summarizeParams(null)).toBe('{}');
    expect(summarizeParams(undefined)).toBe('{}');
  });
});

describe('ApiHandler dispatch logging', () => {
  it('emits a debug entry under [Bridge.Action] when an action is called', async () => {
    const handler = new ApiHandler(emptyContext(), 12345);
    handler.registerAction('echo', async () => ({ status: 'ok', retcode: 0, data: null }));

    await handler.handle('echo', { group_id: 67890, message: [1, 2, 3] });

    const entry = captured.find((e) => e.scope === 'Bridge.Action' && e.level === 'debug');
    expect(entry).toBeDefined();
    expect(entry!.uin).toBe(12345);
    expect(entry!.message).toContain('echo');
    expect(entry!.message).toContain('group_id=67890');
    expect(entry!.message).toContain('message=[len=3]');
  });

  it('emits a warn line with the error stack when the handler throws', async () => {
    const handler = new ApiHandler(emptyContext(), 12345);
    handler.registerAction('boom', async () => {
      throw new Error('kapow');
    });

    const result = await handler.handle('boom', {});
    expect(result.status).toBe('failed');

    const warn = captured.find((e) => e.scope === 'Bridge.Action' && e.level === 'warn');
    expect(warn).toBeDefined();
    expect(warn!.message).toContain('boom');
    expect(warn!.message).toContain('kapow');
    // stack contains the test file path; just check that something stack-shaped is appended
    expect(warn!.message).toMatch(/at\s+/);
  });

  // The single error seam (ADR-0006 narrow seam): any throw from a handler
  // maps to ONE policy here — ACTION_FAILED (100) + the error message —
  // instead of each action hand-rolling its own inconsistent try/catch.
  it('maps any handler throw to ACTION_FAILED (100) with the error message', async () => {
    const handler = new ApiHandler(emptyContext(), 12345);
    handler.registerAction('kaboom', async () => { throw new Error('permission denied'); });

    const result = await handler.handle('kaboom', {});
    expect(result).toMatchObject({ status: 'failed', retcode: 100, wording: 'permission denied' });
  });

  it('surfaces the OidbError code + server message through error.message (no special-casing)', async () => {
    const handler = new ApiHandler(emptyContext(), 12345);
    handler.registerAction('oidb_boom', async () => { throw new OidbError(34, 'no permission', 0x11ec, 2); });

    const result = await handler.handle('oidb_boom', {});
    expect(result).toMatchObject({ status: 'failed', retcode: 100 });
    expect((result as { wording: string }).wording).toContain('34');
    expect((result as { wording: string }).wording).toContain('no permission');
  });

  it('renders a non-Error throw via String()', async () => {
    const handler = new ApiHandler(emptyContext(), 12345);
    handler.registerAction('weird', async () => { throw 'just a string'; });

    const result = await handler.handle('weird', {});
    expect(result).toMatchObject({ status: 'failed', retcode: 100, wording: 'just a string' });
  });

  it('logs unknown actions at debug level', async () => {
    const handler = new ApiHandler(emptyContext(), 99);
    await handler.handle('not_a_real_action', {});

    const entry = captured.find((e) => e.scope === 'Bridge.Action' && e.message.includes('unknown action'));
    expect(entry).toBeDefined();
    expect(entry!.level).toBe('debug');
  });

  it('falls back to the module-level logger (no uin slot) when uin is omitted', async () => {
    const handler = new ApiHandler(emptyContext());
    handler.registerAction('ping', async () => ({ status: 'ok', retcode: 0, data: null }));

    await handler.handle('ping', {});

    const entry = captured.find((e) => e.scope === 'Bridge.Action' && e.level === 'debug');
    expect(entry).toBeDefined();
    expect(entry!.uin).toBeUndefined();
  });
});
