import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const tokenStore = {
  load: () => 'test-token',
  save: () => undefined,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('password strength API client', () => {
  it('returns the server-owned rule evaluation', async () => {
    const rules = [
      { id: 'length', label: '长度不少于 10 位', ok: true },
      { id: 'no-space', label: '不包含空格', ok: true },
    ];
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      rules,
      valid: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient({ tokenStore });
    await expect(client.checkPasswordStrength('Strong-password')).resolves.toEqual({
      rules,
      valid: true,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/auth/check-strength', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ password: 'Strong-password' }),
      headers: {
        Authorization: 'Bearer test-token',
        'Content-Type': 'application/json',
      },
      signal: expect.any(AbortSignal),
    }));
  });

  it('rejects malformed responses instead of silently disabling the form', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      valid: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const client = createApiClient({ tokenStore });
    await expect(client.checkPasswordStrength('candidate')).rejects.toMatchObject({
      status: 502,
      message: '密码强度接口返回了无效响应',
    });
  });

  it('propagates request failures for observable inline validation', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      message: 'strength service unavailable',
    }), {
      status: 503,
      headers: { 'content-type': 'application/json' },
    })));

    const client = createApiClient({ tokenStore });
    await expect(client.checkPasswordStrength('candidate')).rejects.toMatchObject({
      status: 503,
      message: 'strength service unavailable',
    });
  });
});
