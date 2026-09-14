import { afterEach, describe, expect, it, vi } from 'vitest';
import { createApiClient } from '../src/lib/api/client';

const tokenStore = {
  load: () => null as string | null,
  save: vi.fn(),
};

afterEach(() => {
  vi.unstubAllGlobals();
  tokenStore.save.mockReset();
});

describe('login 2FA client', () => {
  it('returns needsTotp without storing a session token', async () => {
    vi.stubGlobal('fetch', vi.fn(async () => new Response(JSON.stringify({
      success: false,
      needsTotp: true,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    })));

    const client = createApiClient({ tokenStore });
    await expect(client.login('Correct-Horse-1!')).resolves.toEqual({ ok: false, needsTotp: true });
    expect(tokenStore.save).not.toHaveBeenCalled();
  });

  it('sends the TOTP on the second login request and stores the session', async () => {
    const fetchMock = vi.fn(async () => new Response(JSON.stringify({
      success: true,
      token: 'session-token',
      mustChangePassword: false,
    }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    }));
    vi.stubGlobal('fetch', fetchMock);

    const client = createApiClient({ tokenStore });
    await expect(client.login('Correct-Horse-1!', { totp: '287082' })).resolves.toEqual({
      ok: true,
      mustChangePassword: false,
    });
    expect(fetchMock).toHaveBeenCalledWith('/api/login', expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ password: 'Correct-Horse-1!', totp: '287082' }),
    }));
    expect(tokenStore.save).toHaveBeenCalledWith('session-token');
  });
});
