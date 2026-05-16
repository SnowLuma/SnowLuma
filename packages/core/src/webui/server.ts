import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { Hono } from 'hono';
import { createLogger, getRecentLogs, subscribeLogs } from '../utils/logger';
import { randomBytes } from 'crypto';
import type { OneBotManager } from '../onebot/manager';
import { loadOneBotConfig, saveOneBotConfig } from '../onebot/config';
import type { OneBotConfig } from '../onebot/types';
import type { HookManager } from '../hook/hook-manager';
import path from 'path';
import { existsSync, readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import os from 'os';
import { WebuiAuth, evaluatePasswordRules, isStrongPassword } from './auth';
import { findAvailablePort } from './port';

const log = createLogger('WebUI');
const __dirname = path.dirname(fileURLToPath(import.meta.url));

interface SessionInfo {
  expiresAt: number;
  mustChangePassword: boolean;
}

const sessionTokens = new Map<string, SessionInfo>();
const loginAttempts = new Map<string, { count: number; resetAt: number }>();

const LOGIN_MAX_ATTEMPTS = 5;
const LOGIN_LOCKOUT_MS = 15 * 60 * 1000;
const TOKEN_TTL_MS = 24 * 60 * 60 * 1000;
const AVATAR_CACHE_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const AVATAR_BROWSER_CACHE_SECONDS = 30 * 24 * 60 * 60;

// Endpoints that an auth-required-but-must-change-password session can still hit.
const MUST_CHANGE_ALLOWLIST = new Set([
  '/api/status',
  '/api/auth/state',
  '/api/auth/check-strength',
  '/api/auth/change-password',
  '/api/logout',
]);

// uin = QQ number; 5–12 digits. Used to construct config file paths,
// so we MUST refuse anything else (path traversal, NUL bytes, etc.).
const UIN_REGEX = /^\d{5,12}$/;

const avatarCache = new Map<string, { body: Uint8Array; contentType: string; expiresAt: number }>();

function purgeExpiredTokens() {
  const now = Date.now();
  for (const [token, info] of sessionTokens) {
    if (now > info.expiresAt) sessionTokens.delete(token);
  }
}

function getClientIp(req: Request): string {
  return req.headers.get('x-forwarded-for')?.split(',')[0].trim() ?? '127.0.0.1';
}

async function fetchQqAvatar(uin: string): Promise<{ body: Uint8Array; contentType: string }> {
  const response = await fetch(`https://q1.qlogo.cn/g?b=qq&nk=${encodeURIComponent(uin)}&s=100`, {
    headers: {
      'User-Agent': 'SnowLuma WebUI',
      Accept: 'image/avif,image/webp,image/apng,image/svg+xml,image/*,*/*;q=0.8',
    },
  });
  if (!response.ok) throw new Error(`avatar upstream responded with ${response.status}`);
  const contentType = response.headers.get('content-type') || 'image/jpeg';
  const body = new Uint8Array(await response.arrayBuffer());
  return { body, contentType };
}

export async function initWebUI(
  desiredPort: number = 5099,
  oneBotManager: OneBotManager,
  hookManager?: HookManager,
): Promise<{ port: number }> {
  const auth = WebuiAuth.load();
  const initialPassword = auth.takeInitialPassword();
  if (auth.isDevMode()) {
    log.warn('dev mode enabled: password=%s', WebuiAuth.devPassword);
    log.warn('dev mode skips config/webui.json and password rotation');
  } else if (initialPassword) {
    log.info('initial credentials: user=admin password=%s', initialPassword);
    log.info('password change required after first login');
  } else if (auth.mustChangePassword()) {
    log.warn('password change is still required');
  }

  const app = new Hono();

  // ─── Auth middleware ─────────────────────────────────────────────────────
  app.use('/api/*', async (c, next) => {
    const reqPath = c.req.path;
    if (reqPath === '/api/login') return next();

    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = c.req.query('token') ?? '';
    const token = bearerToken || queryToken;
    if (!token) return c.json({ status: 'failed', message: 'Unauthorized' }, 401);

    purgeExpiredTokens();
    const info = sessionTokens.get(token);
    if (!info || Date.now() > info.expiresAt) {
      return c.json({ status: 'failed', message: 'Token expired or invalid' }, 401);
    }

    if (info.mustChangePassword && !MUST_CHANGE_ALLOWLIST.has(reqPath)) {
      return c.json({ status: 'failed', message: '请先修改密码', mustChangePassword: true }, 403);
    }

    c.set('sessionToken' as never, token);
    await next();
  });

  // ─── Login ───────────────────────────────────────────────────────────────
  app.post('/api/login', async (c) => {
    const ip = getClientIp(c.req.raw);
    const now = Date.now();
    const attempt = loginAttempts.get(ip);
    if (attempt && attempt.count >= LOGIN_MAX_ATTEMPTS && now < attempt.resetAt) {
      const waitSec = Math.ceil((attempt.resetAt - now) / 1000);
      return c.json({ success: false, message: `登录尝试过多，请 ${waitSec} 秒后重试` }, 429);
    }

    let body: { password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    const password = typeof body.password === 'string' ? body.password : '';
    if (!auth.verify(password)) {
      const current = loginAttempts.get(ip) ?? { count: 0, resetAt: now + LOGIN_LOCKOUT_MS };
      current.count += 1;
      if (current.count === 1) current.resetAt = now + LOGIN_LOCKOUT_MS;
      loginAttempts.set(ip, current);
      return c.json({ success: false, message: '密码错误' }, 401);
    }

    loginAttempts.delete(ip);
    purgeExpiredTokens();
    const token = randomBytes(32).toString('hex');
    const mustChange = auth.mustChangePassword();
    sessionTokens.set(token, { expiresAt: now + TOKEN_TTL_MS, mustChangePassword: mustChange });
    return c.json({ success: true, token, mustChangePassword: mustChange });
  });

  app.post('/api/logout', (c) => {
    const token = c.get('sessionToken' as never) as string | undefined;
    if (token) sessionTokens.delete(token);
    return c.json({ success: true });
  });

  app.get('/api/auth/state', (c) => {
    const token = c.get('sessionToken' as never) as string | undefined;
    const info = token ? sessionTokens.get(token) : undefined;
    return c.json({
      mustChangePassword: info?.mustChangePassword ?? auth.mustChangePassword(),
    });
  });

  app.post('/api/auth/check-strength', async (c) => {
    let body: { password?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ rules: evaluatePasswordRules(''), valid: false });
    }
    const pwd = typeof body.password === 'string' ? body.password : '';
    return c.json({ rules: evaluatePasswordRules(pwd), valid: isStrongPassword(pwd) });
  });

  app.post('/api/auth/change-password', async (c) => {
    let body: { oldPassword?: unknown; newPassword?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    const oldPassword = typeof body.oldPassword === 'string' ? body.oldPassword : '';
    const newPassword = typeof body.newPassword === 'string' ? body.newPassword : '';
    if (!auth.verify(oldPassword)) {
      return c.json({ success: false, message: '当前密码不正确' }, 401);
    }
    if (!isStrongPassword(newPassword)) {
      return c.json(
        { success: false, message: '新密码不符合强度要求', rules: evaluatePasswordRules(newPassword) },
        400,
      );
    }
    if (oldPassword === newPassword) {
      return c.json({ success: false, message: '新密码不得与旧密码相同' }, 400);
    }
    try {
      auth.setPassword(newPassword);
    } catch (err) {
      return c.json({ success: false, message: err instanceof Error ? err.message : String(err) }, 400);
    }
    // Invalidate all other sessions; current keeps but loses must-change flag.
    const currentToken = c.get('sessionToken' as never) as string | undefined;
    for (const [tok, info] of sessionTokens) {
      if (tok === currentToken) {
        info.mustChangePassword = false;
        sessionTokens.set(tok, info);
      } else {
        sessionTokens.delete(tok);
      }
    }
    log.info('password updated');
    return c.json({ success: true });
  });

  // ─── Avatar proxy (uin validated) ────────────────────────────────────────
  app.get('/avatar/:uin', async (c) => {
    const uin = c.req.param('uin');
    if (!UIN_REGEX.test(uin)) return c.text('invalid uin', 400);

    const now = Date.now();
    let cached = avatarCache.get(uin);
    if (!cached || cached.expiresAt <= now) {
      try {
        const avatar = await fetchQqAvatar(uin);
        cached = { ...avatar, expiresAt: now + AVATAR_CACHE_TTL_MS };
        avatarCache.set(uin, cached);
      } catch (err) {
        log.warn('failed to proxy avatar for UIN %s: %s', uin, err instanceof Error ? err.message : String(err));
        if (!cached) return c.text('avatar unavailable', 502);
      }
    }
    return new Response(cached.body, {
      headers: {
        'Content-Type': cached.contentType,
        'Cache-Control': `public, max-age=${AVATAR_BROWSER_CACHE_SECONDS}, immutable`,
      },
    });
  });

  // ─── Read-only API ───────────────────────────────────────────────────────
  app.get('/api/status', (c) => c.json({ status: 'running' }));

  // Host system info
  let lastCpuTimes: { idle: number; total: number }[] | null = null;
  function sampleCpuLoad(): number[] {
    const cpus = os.cpus();
    const current = cpus.map((cpu) => {
      const t = cpu.times;
      const total = t.user + t.nice + t.sys + t.idle + t.irq;
      return { idle: t.idle, total };
    });
    if (!lastCpuTimes || lastCpuTimes.length !== current.length) {
      lastCpuTimes = current;
      return current.map(() => 0);
    }
    const usage = current.map((cur, i) => {
      const prev = lastCpuTimes![i];
      const totalDiff = cur.total - prev.total;
      const idleDiff = cur.idle - prev.idle;
      if (totalDiff <= 0) return 0;
      return Math.max(0, Math.min(100, ((totalDiff - idleDiff) / totalDiff) * 100));
    });
    lastCpuTimes = current;
    return usage;
  }

  app.get('/api/system', (c) => {
    const cpus = os.cpus();
    const usage = sampleCpuLoad();
    const totalMem = os.totalmem();
    const freeMem = os.freemem();
    const usedMem = totalMem - freeMem;
    const runtimeMemory = process.memoryUsage();
    return c.json({
      hostname: os.hostname(),
      platform: os.platform(),
      arch: os.arch(),
      release: os.release(),
      uptime: os.uptime(),
      processUptime: process.uptime(),
      nodeVersion: process.version,
      cpu: {
        model: cpus[0]?.model ?? 'unknown',
        cores: cpus.length,
        speedMHz: cpus[0]?.speed ?? 0,
        loadAvg: os.loadavg(),
        perCore: usage,
        average: usage.length ? usage.reduce((s, v) => s + v, 0) / usage.length : 0,
      },
      memory: {
        total: totalMem,
        free: freeMem,
        used: usedMem,
        usagePercent: totalMem ? (usedMem / totalMem) * 100 : 0,
      },
      runtime: {
        pid: process.pid,
        rss: runtimeMemory.rss,
        heapTotal: runtimeMemory.heapTotal,
        heapUsed: runtimeMemory.heapUsed,
        external: runtimeMemory.external,
        arrayBuffers: runtimeMemory.arrayBuffers,
      },
    });
  });

  app.get('/api/qq-list', (c) => {
    const instances = oneBotManager.getInstances();
    const list = instances.map((inst) => ({ uin: inst.uin, nickname: inst.nickname }));
    return c.json({ list });
  });

  app.get('/api/logs', (c) => {
    const limit = Number(c.req.query('limit') ?? 300);
    return c.json({ list: getRecentLogs(limit) });
  });

  app.get('/api/logs/stream', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        const send = (event: unknown) => {
          controller.enqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        send({ type: 'ready' });
        const unsubscribe = subscribeLogs((entry) => send(entry));
        const heartbeat = setInterval(() => {
          controller.enqueue(encoder.encode(': heartbeat\n\n'));
        }, 15000);
        c.req.raw.signal.addEventListener('abort', () => {
          clearInterval(heartbeat);
          unsubscribe();
          try {
            controller.close();
          } catch {
            /* ignore */
          }
        });
      },
    });
    return new Response(stream, {
      headers: {
        'Content-Type': 'text/event-stream',
        'Cache-Control': 'no-cache',
        Connection: 'keep-alive',
      },
    });
  });

  app.get('/api/processes', async (c) => {
    if (!hookManager) return c.json({ list: [] });
    try {
      return c.json({ list: await hookManager.listProcesses() });
    } catch (err) {
      return c.json({ list: [], message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/api/processes/:pid/load', async (c) => {
    if (!hookManager) return c.json({ success: false, message: 'hook manager is not available' }, 503);
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
      return c.json({ success: false, message: 'invalid pid' }, 400);
    }
    try {
      const processInfo = await hookManager.loadProcess(pid);
      return c.json({ success: processInfo.status !== 'error', process: processInfo });
    } catch (err) {
      return c.json({ success: false, message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/api/processes/:pid/unload', async (c) => {
    if (!hookManager) return c.json({ success: false, message: 'hook manager is not available' }, 503);
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
      return c.json({ success: false, message: 'invalid pid' }, 400);
    }
    try {
      const processInfo = await hookManager.unloadProcess(pid);
      return c.json({ success: processInfo.status !== 'error', process: processInfo });
    } catch (err) {
      return c.json({ success: false, message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.post('/api/processes/:pid/refresh', async (c) => {
    if (!hookManager) return c.json({ success: false, message: 'hook manager is not available' }, 503);
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid <= 0 || pid > 4_194_304) {
      return c.json({ success: false, message: 'invalid pid' }, 400);
    }
    try {
      const processInfo = await hookManager.refreshProcess(pid);
      return c.json({ success: processInfo.status !== 'error', process: processInfo });
    } catch (err) {
      return c.json({ success: false, message: err instanceof Error ? err.message : String(err) }, 500);
    }
  });

  app.get('/api/config/:uin', (c) => {
    const uin = c.req.param('uin');
    if (!UIN_REGEX.test(uin)) return c.json({ message: 'invalid uin' }, 400);
    const config = loadOneBotConfig(uin);
    return c.json({
      ...config,
      config,
    });
  });

  app.post('/api/config/:uin', async (c) => {
    try {
      const uin = c.req.param('uin');
      if (!UIN_REGEX.test(uin)) return c.json({ success: false, message: 'invalid uin' }, 400);
      const body = (await c.req.json()) as OneBotConfig;
      saveOneBotConfig(uin, body);
      const reloaded = oneBotManager.reloadConfig(uin);
      log.info('Updated OneBot config for UIN: %s%s', uin, reloaded ? ' and reloaded' : '');
      return c.json({
        success: true,
        reloaded,
        message: reloaded ? '配置保存成功，已热重载当前会话。' : '配置保存成功，当前会话未在线，将在下次连接时生效。',
      });
    } catch (err) {
      return c.json({ success: false, message: String(err) }, 400);
    }
  });

  // ─── Static frontend ─────────────────────────────────────────────────────
  // Build path is relative to the bundled / dev __dirname. SPA fallback to
  // index.html so client-side routes (if any) keep working.
  const staticRoot = path.resolve(__dirname, 'client');
  app.use('/*', serveStatic({ root: staticRoot }));

  const indexHtmlPath = path.join(staticRoot, 'index.html');
  app.get('*', (c) => {
    // SPA fallback: only for navigations that didn't hit a static asset.
    if (c.req.path.startsWith('/api/') || c.req.path.startsWith('/avatar/')) {
      return c.text('not found', 404);
    }
    if (existsSync(indexHtmlPath)) {
      const html = readFileSync(indexHtmlPath, 'utf8');
      return c.html(html);
    }
    return c.text(
      'WebUI client bundle not found. Run `pnpm --filter webui build` (or use the dev server on :5178).',
      404,
    );
  });

  const finalPort = await findAvailablePort(desiredPort);
  if (finalPort !== desiredPort) {
    log.warn('port %d is in use, using %d instead', desiredPort, finalPort);
  }

  await new Promise<void>((resolve) => {
    serve({ fetch: app.fetch, port: finalPort }, (info) => {
      log.info(`listening http://localhost:${info.port}`);
      resolve();
    });
  });
  return { port: finalPort };
}
