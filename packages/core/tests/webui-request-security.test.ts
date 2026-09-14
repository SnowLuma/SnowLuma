import { Hono } from 'hono';
import { describe, expect, it } from 'vitest';
import {
  clearAvatarSessionCookie,
  extractBearerToken,
  LOGIN_BODY_LIMIT_BYTES,
  readAvatarSessionToken,
  registerLoginRequestSecurity,
  setAvatarSessionCookie,
  webuiSecurityHeaders,
} from '../src/webui/request-security';

describe('WebUI public request security', () => {
  it('rejects an oversized login body before JSON parsing', async () => {
    const app = new Hono();
    app.use('*', webuiSecurityHeaders);
    registerLoginRequestSecurity(app);
    app.post('/api/login', async (c) => c.json(await c.req.json()));

    const response = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ password: 'x'.repeat(LOGIN_BODY_LIMIT_BYTES) }),
    });

    expect(response.status).toBe(413);
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    await expect(response.json()).resolves.toMatchObject({ success: false });
  });

  it('accepts normal JSON login requests and rejects misleading content types', async () => {
    const app = new Hono();
    registerLoginRequestSecurity(app);
    app.post('/api/login', async (c) => c.json(await c.req.json()));

    const accepted = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'application/problem+json' },
      body: JSON.stringify({ password: 'normal-password' }),
    });
    const rejected = await app.request('/api/login', {
      method: 'POST',
      headers: { 'content-type': 'text/plain' },
      body: JSON.stringify({ password: 'normal-password' }),
    });

    expect(accepted.status).toBe(200);
    expect(rejected.status).toBe(415);
  });

  it('never treats a query parameter as a bearer credential', () => {
    expect(extractBearerToken(new Request('http://localhost/api/state/stream?token=leaked'))).toBe('');
    expect(extractBearerToken(new Request('http://localhost/api/state/stream', {
      headers: { authorization: 'Bearer header-token' },
    }))).toBe('header-token');
  });

  it('round-trips an HttpOnly avatar session cookie and clears it on logout', async () => {
    const app = new Hono();
    app.get('/set', (c) => {
      setAvatarSessionCookie(c, 'session-token', false);
      return c.text('ok');
    });
    app.get('/read', (c) => c.text(readAvatarSessionToken(c)));
    app.get('/clear', (c) => {
      clearAvatarSessionCookie(c, false);
      return c.text('ok');
    });

    const setResponse = await app.request('/set');
    const setCookie = setResponse.headers.get('set-cookie') ?? '';
    expect(setCookie).toContain('HttpOnly');
    expect(setCookie).toContain('SameSite=Strict');
    expect(setCookie).toContain('Path=/avatar');

    const cookie = setCookie.split(';', 1)[0];
    const readResponse = await app.request('/read', { headers: { cookie } });
    expect(await readResponse.text()).toBe('session-token');

    const clearResponse = await app.request('/clear');
    expect(clearResponse.headers.get('set-cookie')).toMatch(/Max-Age=0/i);
  });

  it('adds security headers without imposing a script or style policy', async () => {
    const app = new Hono();
    app.use('*', webuiSecurityHeaders);
    app.get('/', (c) => c.html('<main>SnowLuma</main>'));

    const response = await app.request('/');
    expect(response.headers.get('x-frame-options')).toBe('DENY');
    expect(response.headers.get('x-content-type-options')).toBe('nosniff');
    expect(response.headers.get('referrer-policy')).toBe('no-referrer');
    expect(response.headers.get('content-security-policy')).toBe(
      "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
    );
  });
});
