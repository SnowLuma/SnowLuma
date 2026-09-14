import { bodyLimit } from 'hono/body-limit';
import { deleteCookie, getCookie, setCookie } from 'hono/cookie';
import type { Context, Hono, MiddlewareHandler } from 'hono';

export const LOGIN_BODY_LIMIT_BYTES = 16 * 1024;
const AVATAR_SESSION_COOKIE = 'snowluma_avatar_session';
const AVATAR_SESSION_MAX_AGE_SECONDS = 24 * 60 * 60;

function isJsonMediaType(value: string | undefined): boolean {
  const mediaType = value?.split(';', 1)[0]?.trim().toLowerCase() ?? '';
  return mediaType === 'application/json' || mediaType.endsWith('+json');
}

/** Install guards before the login route is registered. */
export function registerLoginRequestSecurity(app: Hono): void {
  app.use('/api/login', bodyLimit({
    maxSize: LOGIN_BODY_LIMIT_BYTES,
    onError: (c) => c.json({ success: false, message: '请求体过大' }, 413),
  }));
  app.use('/api/login', async (c, next) => {
    if (!isJsonMediaType(c.req.header('content-type'))) {
      return c.json({ success: false, message: 'Content-Type 必须为 application/json' }, 415);
    }
    return next();
  });
}

/** Minimal response policy that does not restrict the current script/style bundle. */
export const webuiSecurityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.res.headers.set('X-Frame-Options', 'DENY');
  c.res.headers.set('X-Content-Type-Options', 'nosniff');
  c.res.headers.set('Referrer-Policy', 'no-referrer');
  c.res.headers.set(
    'Content-Security-Policy',
    "frame-ancestors 'none'; base-uri 'self'; object-src 'none'",
  );
};

export function extractBearerToken(request: Request): string {
  const authorization = request.headers.get('authorization');
  return authorization?.startsWith('Bearer ') ? authorization.slice(7) : '';
}

const avatarCookieOptions = (secure: boolean) => ({
  httpOnly: true,
  sameSite: 'Strict' as const,
  secure,
  path: '/avatar',
});

export function setAvatarSessionCookie(c: Context, token: string, secure: boolean): void {
  setCookie(c, AVATAR_SESSION_COOKIE, token, {
    ...avatarCookieOptions(secure),
    maxAge: AVATAR_SESSION_MAX_AGE_SECONDS,
  });
}

export function clearAvatarSessionCookie(c: Context, secure: boolean): void {
  deleteCookie(c, AVATAR_SESSION_COOKIE, avatarCookieOptions(secure));
}

export function readAvatarSessionToken(c: Context): string {
  return getCookie(c, AVATAR_SESSION_COOKIE) ?? '';
}
