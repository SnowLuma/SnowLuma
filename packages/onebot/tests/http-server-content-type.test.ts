// Tests for HTTP server adapter content-type parsing (POST body).
// Covers: application/x-www-form-urlencoded, application/json,
// no content-type fallback, and unsupported content-type rejection.

import { describe, expect, it, vi, beforeAll, afterAll } from 'vitest';
import http from 'http';
import { HttpServerAdapter } from '../src/network/http-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { HttpServerNetwork } from '../src/types';

// ─── Helpers ───

function fakeCtx(handleFn: (action: string, params: Record<string, unknown>) => unknown): NetworkAdapterContext {
  return {
    uin: '10001',
    api: {
      handle: vi.fn(async (action: string, params: Record<string, unknown>) => {
        const data = handleFn(action, params);
        return { status: 'ok', retcode: 0, data };
      }),
      isStreamAction: () => false,
    } as any,
    buildLifecycleEvent: vi.fn(() => ({})),
    buildHeartbeatEvent: vi.fn(() => ({})),
  };
}

function post(port: number, path: string, body: string, headers: Record<string, string> = {}): Promise<{ status: number; body: any }> {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path, method: 'POST', headers }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const raw = Buffer.concat(chunks).toString('utf8');
        try {
          resolve({ status: res.statusCode!, body: JSON.parse(raw) });
        } catch {
          resolve({ status: res.statusCode!, body: raw });
        }
      });
    });
    req.on('error', reject);
    req.end(body);
  });
}

// ─── Tests ───

describe('HttpServerAdapter content-type parsing', () => {
  let adapter: HttpServerAdapter;
  let handleFn: ReturnType<typeof vi.fn<(action: string, params: Record<string, unknown>) => unknown>>;
  const PORT = 19876;

  beforeAll(async () => {
    handleFn = vi.fn((_action: string, params: Record<string, unknown>) => params);
    const ctx = fakeCtx(handleFn);
    const config: HttpServerNetwork = { name: 'test-http', port: PORT, enabled: true, messageFormat: 'array', reportSelfMessage: false };
    adapter = new HttpServerAdapter('test-http', config, ctx);
    await adapter.open();
  });

  afterAll(async () => {
    await adapter.close();
  });

  it('should parse application/json body', async () => {
    const res = await post(PORT, '/send_message', JSON.stringify({ params: { group_id: 123, message: 'hi' } }), {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(handleFn).toHaveBeenCalledWith('send_message', { group_id: 123, message: 'hi' });
  });

  it('should parse application/x-www-form-urlencoded body', async () => {
    handleFn.mockClear();
    const body = 'group_id=456&message=hello';
    const res = await post(PORT, '/send_message', body, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(200);
    expect(res.body.status).toBe('ok');
    expect(handleFn).toHaveBeenCalledWith('send_message', { group_id: 456, message: 'hello' });
  });

  it('should JSON-parse values in urlencoded body', async () => {
    handleFn.mockClear();
    const body = 'user_id=789&data={"nested":true}';
    const res = await post(PORT, '/get_info', body, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(200);
    expect(handleFn).toHaveBeenCalledWith('get_info', { user_id: 789, data: { nested: true } });
  });

  it('should extract action from urlencoded body when path has no action', async () => {
    handleFn.mockClear();
    const body = 'action=get_status&key=value';
    const res = await post(PORT, '/', body, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(200);
    expect(handleFn).toHaveBeenCalledWith('get_status', { key: 'value' });
  });

  it('should extract echo from urlencoded body', async () => {
    handleFn.mockClear();
    const body = 'action=test_action&echo=12345&foo=bar';
    const res = await post(PORT, '/', body, {
      'content-type': 'application/x-www-form-urlencoded',
    });
    expect(res.status).toBe(200);
    expect(res.body.echo).toBe(12345);
    expect(handleFn).toHaveBeenCalledWith('test_action', { foo: 'bar' });
  });

  it('should reject unsupported content-type with 400', async () => {
    const res = await post(PORT, '/send_message', '<xml></xml>', {
      'content-type': 'application/xml',
    });
    expect(res.status).toBe(400);
    expect(res.body.wording).toContain('unsupported content-type');
  });

  it('should reject invalid JSON with explicit application/json content-type', async () => {
    const res = await post(PORT, '/send_message', 'not-json{{{', {
      'content-type': 'application/json',
    });
    expect(res.status).toBe(400);
    expect(res.body.wording).toContain('invalid json');
  });

  it('should fallback to urlencoded when no content-type and body is not valid JSON', async () => {
    handleFn.mockClear();
    const body = 'action=fallback_action&param1=value1';
    const res = await post(PORT, '/', body, {});
    expect(res.status).toBe(200);
    expect(handleFn).toHaveBeenCalledWith('fallback_action', { param1: 'value1' });
  });

  it('should parse JSON when no content-type and body is valid JSON', async () => {
    handleFn.mockClear();
    const body = JSON.stringify({ action: 'json_action', params: { x: 1 } });
    const res = await post(PORT, '/', body, {});
    expect(res.status).toBe(200);
    expect(handleFn).toHaveBeenCalledWith('json_action', { x: 1 });
  });
});
