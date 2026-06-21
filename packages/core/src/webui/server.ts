import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import type { HookManager, HookProcessInfo } from '@snowluma/bridge';
import { createLogger, getLogLevel, getRecentLogs, LOG_LEVELS, setLogLevel, subscribeLogs } from '@snowluma/common/logger';
import { loadOneBotConfig, saveOneBotConfig } from '@snowluma/onebot/config';
import type { OneBotManager } from '@snowluma/onebot/manager';
import type { OneBotConfig, JsonObject as OneBotJsonObject } from '@snowluma/onebot/types';
import { readRuntimeConfig, updateRuntimeConfig, resolveRuntimeEnvOverrides } from '@snowluma/common/runtime';
import { execSync } from 'child_process';
import { randomBytes } from 'crypto';
import { chmodSync, copyFileSync, existsSync, mkdirSync, readdirSync, readFileSync, renameSync, rmSync, writeFileSync } from 'fs';
import { createServer as createHttpsServer } from 'https';
import { Hono, type Context } from 'hono';
import os from 'os';
import path from 'path';
import { fileURLToPath } from 'url';
import { evaluatePasswordRules, isStrongPassword, WebuiAuth } from './auth';
import { getAgreementsPayload, isConsentRequired, loadAgreements, recordConsent } from './consent';
import { resolveTlsContext, validateTlsPair } from './tls';
import { coerceSettingsPatch } from './system-settings';
import { buildBackup, planRestore, validateBackup } from './backup';
import { collectActionDocs, collectCategories } from '@snowluma/onebot/action-docs';
import { createFramePusher } from './debug-stream';
import { describeTrustProxy, makeClientIpResolver, parseTrustProxy } from './client-ip';
import { findAvailablePort } from './port';
import {
  clearBackgroundImage,
  loadUiConfig,
  MAX_BACKGROUND_BYTES,
  publicAppearance,
  readBackgroundImage,
  saveUiConfig,
  sniffImageMime,
  writeBackgroundImage,
} from './ui-config';
import { getUpdateInfo } from './update-check';
import { loadNotificationsConfig, saveNotificationsConfig } from '../notifications/config';
import type { NotificationManager } from '../notifications/manager';

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
  // Consent is collected AFTER login but BEFORE the forced password change, so
  // reading + recording it must be reachable while the session mustChangePassword.
  '/api/agreements',
  '/api/agreements/record-consent',
  '/api/logout',
]);

// Endpoints reachable while consent is still pending. Everything else is 403'd
// with consentRequired:true until the operator accepts — the same server-side
// enforcement pattern as MUST_CHANGE_ALLOWLIST, so the consent gate is real and
// not merely a frontend convention. Ordered BEFORE the must-change gate so a
// fresh install must consent first, then set its password.
const CONSENT_ALLOWLIST = new Set([
  '/api/status',
  '/api/auth/state',
  '/api/agreements',
  '/api/agreements/record-consent',
  '/api/logout',
]);

// Endpoints that may authenticate via `?token=` query parameter. Only the
// SSE log stream is here because EventSource cannot set custom headers; all
// other endpoints MUST use the Authorization header so tokens never leak
// into access logs / Referer / browser history.
const TOKEN_QUERY_ALLOWLIST = new Set([
  '/api/logs/stream',
  '/api/debug/stream',
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
  for (const [ip, attempt] of loginAttempts) {
    if (now > attempt.resetAt) loginAttempts.delete(ip);
  }
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

// ── Host system info (cached at module level, invariant over process lifetime) ──

function detectDistro(): string {
  // Helper: extract major.minor.patch from a kernel version string
  const parseKernel = (v: string): string | null => { const m = v.match(/(\d+\.\d+\.\d+)/); return m?.[1] ?? null; };

  // ── Linux ──────────────────────────────────────────────────────────
  if (os.platform() === 'linux') {
    const kernelRelease = os.release();
    const kernelVer = parseKernel(kernelRelease);

    // Normalize RHEL-family distro names before comparison.
    // /proc/version typically shows "Red Hat" (GCC build tag) even on
    // Rocky / Alma / Oracle Linux, while /etc/os-release carries the
    // actual distro name.  Treat the whole family as a single group so
    // they are never considered "disagreeing".
    const isRhelFamily = (name: string): boolean =>
      /^(red hat|centos|rocky|alma|oracle|scientific|anolis|tencentos|bclinux|opencloudos)/.test(name);

    // Extract distro version from kernel release string.
    // Distros embed their version in the kernel ABI / build tag:
    //   Debian: "6.8.12-1-deb13-amd64"             → 13
    //   RHEL family: "4.18.0-513.el9.x86_64"        → 9
    //   Fedora: "6.8.12-300.fc40.x86_64"            → 40
    //   Amazon Linux: "6.1.158-178.288.amzn2023"    → 2023
    //   Mageia: "6.8.12-1.mga10"                    → 10
    const kernelDistroVer = (distro: string | null): string | null => {
      if (!distro) return null;
      const lr = kernelRelease.toLowerCase();
      const ld = distro.toLowerCase();
      if (ld === 'debian') { const m = lr.match(/deb(\d+)/); if (m) return m[1]; }
      if (isRhelFamily(ld)) { const m = lr.match(/el(\d+)/); if (m) return m[1]; }
      if (ld === 'fedora') { const m = lr.match(/fc(\d+)/); if (m) return m[1]; }
      if (ld === 'amazon' || ld.includes('amazon')) { const m = lr.match(/amzn(\d+)/); if (m) return m[1]; }
      if (ld === 'mageia') { const m = lr.match(/mga(\d+)/); if (m) return m[1]; }
      if (ld === 'armbian') { const m = lr.match(/armbian(\d+)/); if (m) return m[1]; }
      if (ld === 'dietpi') { const m = lr.match(/dietpi(\d+)/); if (m) return m[1]; }
      if (ld.includes('libreelec')) { const m = lr.match(/libreelec(\d+)/); if (m) return m[1]; }
      if (ld.includes('coreelec')) { const m = lr.match(/coreelec(\d+)/); if (m) return m[1]; }
      return null;
    };

    // Source A: /proc/version (host kernel build, crosses container boundary)
    let hostName: string | null = null;
    try {
      const raw = readFileSync('/proc/version', 'utf8').trim();
      const vm = raw.match(/^Linux version\s+(\S+)/);
      if (vm) {
        // Step 1: kernel release string — embedded distros embed their name
        // here (e.g. "6.6.16-armbian", "6.1.60-dietpi"). More reliable than
        // the GCC build tag, which often shows the cross-compilation toolchain
        // (e.g. "Ubuntu" for Armbian / DietPi) rather than the actual OS.
        const releaseStr = vm[1].toLowerCase();
        const releaseNameMatch = releaseStr.match(/(armbian|dietpi|libreelec|coreelec)/);
        if (releaseNameMatch) {
          const nameMap: Record<string, string> = {
            armbian: 'Armbian',
            dietpi: 'DietPi',
            libreelec: 'LibreELEC',
            coreelec: 'CoreELEC',
          };
          hostName = nameMap[releaseNameMatch[1]] ?? releaseNameMatch[1];
        } else {
          // Step 2: GCC build tag — matches the distribution that compiled
          // the running kernel (e.g. "(Ubuntu ...)", "(Debian ...)",
          // "(Red Hat ...)").
          const dm = raw.match(/\b(Debian|Ubuntu|Red Hat|CentOS|Fedora|Alpine|Arch|Gentoo|SUSE|Proxmox|OpenWrt|Deepin|Kylin|openEuler|Anolis|UOS|Linux Mint|Slackware|Manjaro|NixOS|Void|Mageia|Kali|Amazon|Solus|Alibaba|Armbian|DietPi|Raspbian)\b/i);
          hostName = dm ? dm[1] : null;
        }
      }
    } catch { /* source A unavailable */ }

    // Source B: /etc/os-release (container / local OS)
    let osReleaseName: string | null = null;
    let osReleaseVer: string | null = null;
    try {
      for (const f of ['/etc/os-release', '/usr/lib/os-release']) {
        if (!existsSync(f)) continue;
        const raw = readFileSync(f, 'utf8');
        const get = (k: string) => { const m = raw.match(new RegExp(`^${k}=("?)(.+?)\\1$`, 'm')); return m?.[2] ?? null; };
        const pretty = get('PRETTY_NAME') || get('NAME');
        const ver = get('VERSION_ID');
        if (pretty) {
          const nm = pretty.match(/^([^0-9]+)/);
          osReleaseName = nm ? nm[1].trim() : pretty;
          osReleaseVer = ver;
          break;
        }
      }
    } catch { /* source B unavailable */ }

    // Decide which source to trust for the distro name & version
    let finalName: string;
    let finalVer: string | null;

    if (hostName && osReleaseName) {
      // Normalize and compare: e.g. "Debian" vs "Debian GNU/Linux" → match.
      // RHEL family members (Red Hat, CentOS, Rocky, Alma, Oracle, Scientific)
      // are normalised to the same group — /proc/version usually shows "Red Hat"
      // (GCC build tag) even when the actual distro is Rocky / Alma / Oracle.
      const a = hostName.toLowerCase();
      const b = osReleaseName.toLowerCase();
      if (a.includes(b) || b.includes(a) || (isRhelFamily(a) && isRhelFamily(b))) {
        // Agree → prefer version from kernel release, fall back to os-release
        finalName = osReleaseName;
        finalVer = kernelDistroVer(hostName) ?? osReleaseVer;
      } else {
        // Disagree → host kernel build wins (crosses container boundary)
        finalName = hostName;
        finalVer = kernelDistroVer(hostName);
      }
    } else if (hostName) {
      finalName = hostName;
      finalVer = kernelDistroVer(hostName);
    } else if (osReleaseName) {
      finalName = osReleaseName;
      finalVer = kernelDistroVer(osReleaseName) ?? osReleaseVer;
    } else {
      // Source C: legacy release files
      for (const [path, prefix] of [
        ['/etc/alpine-release', 'Alpine Linux '],
        ['/etc/redhat-release', ''],
        ['/etc/debian_version', 'Debian '],
      ] as [string, string][]) {
        try {
          if (existsSync(path)) {
            const raw = prefix + readFileSync(path, 'utf8').trim();
            return kernelVer ? `${raw} (kernel ${kernelVer})` : raw;
          }
        } catch { /* try next */ }
      }
      return kernelVer ? `Linux (kernel ${kernelVer})` : 'Linux';
    }

    // Unified output: <Name> <version> (kernel <kernel>)
    const base = finalVer ? `${finalName} ${finalVer}` : finalName;
    return kernelVer ? `${base} (kernel ${kernelVer})` : base;
  }

  // ── Windows ────────────────────────────────────────────────────────
  if (os.platform() === 'win32') {
    try {
      const productName = execSync(
        'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v ProductName',
        { encoding: 'utf8', timeout: 3000, stdio: 'pipe' },
      );
      const m = productName.match(/ProductName\s+REG_SZ\s+(.+)/);
      let name = m ? m[1].trim() : `Windows ${os.release()}`;
      // ProductName is still "Windows 10 Pro" on Windows 11 — check build number.
      try {
        const buildOut = execSync(
          'reg query "HKLM\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion" /v CurrentBuildNumber',
          { encoding: 'utf8', timeout: 3000, stdio: 'pipe' },
        );
        const bm = buildOut.match(/CurrentBuildNumber\s+REG_SZ\s+(\d+)/);
        if (bm && parseInt(bm[1], 10) >= 22000) {
          name = name.replace(/^Windows 10/, 'Windows 11');
        }
      } catch { /* keep name as-is */ }
      return name;
    } catch { /* fall through */ }
    return `Windows ${os.release()}`;
  }

  return os.platform();
}

function normalizeArch(arch: string): string {
  const map: Record<string, string> = {
    loong64: 'LoongArch',
    riscv64: 'RISC-V',
    mips: 'MIPS',
    mipsel: 'MIPS (LE)',
    arm: 'ARM',
    arm64: 'ARM64',
    x64: 'x86_64',
    ia32: 'x86',
    s390: 'S/390',
    s390x: 'S/390x',
    ppc: 'PowerPC',
    ppc64: 'PowerPC64',
    ppc64le: 'PowerPC64 (LE)',
  };
  return map[arch] ?? arch;
}

const CACHED_DISTRO = (() => { try { return detectDistro(); } catch { return os.platform(); } })();
const CACHED_ARCH_LABEL = normalizeArch(os.arch());

export async function initWebUI(
  desiredPort: number = 5099,
  oneBotManager: OneBotManager,
  hookManager?: HookManager,
  notificationManager?: NotificationManager,
  listener: { host?: string; tlsEnabled?: boolean; trustProxy?: string } = {},
): Promise<{ port: number }> {
  // Resolve the client IP for per-IP rate limiting from the configured
  // trust-proxy directive (runtime.json `trustProxy`, env-overridable via
  // SNOWLUMA_WEBUI_TRUST_PROXY which loadRuntimeConfig already merged in).
  // Default ('') = trust the TCP socket peer only (cannot be spoofed).
  const trustProxyMode = parseTrustProxy(listener.trustProxy);
  const getClientIp = makeClientIpResolver(trustProxyMode);

  // Actual bound port (set just before serve; findAvailablePort may bump it).
  // Read by GET /api/system/settings so the panel shows what's really live.
  let boundPort = desiredPort;

  const auth = WebuiAuth.load();
  const initialPassword = auth.takeInitialPassword();
  if (auth.isDevMode()) {
    log.warn('dev mode enabled: password=%s', WebuiAuth.devPassword);
    log.warn('dev mode skips config/webui.json and password rotation');
  } else if (initialPassword) {
    log.info('════════════════════════════════════════════════════════════════');
    log.info('  ★ WebUI 初始登录凭据 / Initial WebUI Credentials ★');
    log.info('  请立即登录并修改密码 —— 关闭程序后此密码无法找回。');
    log.info('  若跳过初始改密，下次启动将自动生成新的随机密码。');
    log.info('  Log in and change the password now; it will not be shown again.');
    log.info('────────────────────────────────────────────────────────────────');
    log.info('initial credentials: user=admin password=%s', initialPassword);
    log.info('════════════════════════════════════════════════════════════════');
  } else if (auth.mustChangePassword()) {
    log.warn('password change is still required');
  }
  log.info('login rate-limit keyed by: %s', describeTrustProxy(trustProxyMode));
  if (trustProxyMode.kind === 'all') {
    log.warn('SNOWLUMA_WEBUI_TRUST_PROXY=1 — only safe behind a reverse proxy that strips client-set X-Real-IP / X-Forwarded-For');
  }

  // Memoized once at startup (agreements version is fixed per process; a text
  // change ships with a redeploy that restarts us). Flipped to false the moment
  // consent is recorded, so the middleware never touches disk per request.
  let consentGatePending = isConsentRequired();
  if (consentGatePending) log.info('awaiting EULA/PRIVACY consent before the panel unlocks');

  const app = new Hono();

  // ─── Anti-indexing ───────────────────────────────────────────────────────
  // The WebUI is an admin surface that has no business showing up in
  // search results — even the login page leaks the existence of a
  // SnowLuma instance to anyone scanning the IP. Three overlapping
  // signals: a hard X-Robots-Tag on every response, a robots.txt for
  // crawlers that read it before pages, and a <meta robots> in the
  // SPA shell for the case where a proxy strips headers.
  app.use('*', async (c, next) => {
    await next();
    c.res.headers.set(
      'X-Robots-Tag',
      'noindex, nofollow, noarchive, nosnippet, noimageindex',
    );
  });

  app.get('/robots.txt', (c) => {
    c.res.headers.set('Content-Type', 'text/plain; charset=utf-8');
    return c.body('User-agent: *\nDisallow: /\n');
  });

  // ─── Auth middleware ─────────────────────────────────────────────────────
  app.use('/api/*', async (c, next) => {
    const reqPath = c.req.path;
    // `/api/ui/public` serves the cosmetic appearance subset to the
    // pre-auth login page, so it must skip the bearer check. It exposes
    // nothing sensitive (no layout, no secrets) — see ui-config.ts.
    if (reqPath === '/api/login' || reqPath === '/api/ui/public') return next();

    const authHeader = c.req.header('Authorization');
    const bearerToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : '';
    const queryToken = TOKEN_QUERY_ALLOWLIST.has(reqPath) ? (c.req.query('token') ?? '') : '';
    const token = bearerToken || queryToken;
    if (!token) return c.json({ status: 'failed', message: 'Unauthorized' }, 401);

    const info = sessionTokens.get(token);
    if (!info || Date.now() > info.expiresAt) {
      return c.json({ status: 'failed', message: 'Token expired or invalid' }, 401);
    }

    // Consent gate (before the password gate): block everything outside the
    // consent allowlist until the operator has accepted the current agreements.
    // `consentGatePending` is memoized (see below) so this is a Set lookup, not
    // a disk read, on the hot path.
    if (consentGatePending && !CONSENT_ALLOWLIST.has(reqPath)) {
      return c.json(
        { status: 'failed', message: '请先阅读并同意用户协议与隐私政策', consentRequired: true },
        403,
      );
    }

    if (info.mustChangePassword && !MUST_CHANGE_ALLOWLIST.has(reqPath)) {
      return c.json({ status: 'failed', message: '请先修改密码', mustChangePassword: true }, 403);
    }

    c.set('sessionToken' as never, token);
    await next();
  });

  // Periodic janitor — keeps sessionTokens / loginAttempts from growing
  // unbounded and replaces the per-request O(n) sweep we used to do.
  const tokenJanitor = setInterval(purgeExpiredTokens, 60_000);
  tokenJanitor.unref?.();

  // ─── Login ───────────────────────────────────────────────────────────────
  app.post('/api/login', async (c) => {
    const ip = getClientIp(c);
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
      log.warn('change password failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '密码修改失败' }, 400);
    }
    // Invalidate every session, including the current one. If the old
    // password was compromised, the attacker may already hold the current
    // token; rotating credentials must rotate sessions too.
    sessionTokens.clear();
    log.info('password updated; all sessions invalidated');
    return c.json({ success: true, requireRelogin: true });
  });

  // ─── EULA / PRIVACY consent ──────────────────────────────────────────────
  // Both are bearer-gated (consent is collected AFTER login) and live in the
  // consent + must-change allowlists so they're reachable during onboarding.
  // The version is content-derived, so consent is stable across app upgrades
  // and re-prompted only when the agreement text itself changes.
  app.get('/api/agreements', (c) => c.json(getAgreementsPayload()));

  app.post('/api/agreements/record-consent', async (c) => {
    let body: { version?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    const version = typeof body.version === 'string' ? body.version : '';
    const current = loadAgreements().version;
    // Reject a stale/blank version so a client that read an older agreement set
    // can't record consent that the server would then treat as current.
    if (!version || version !== current) {
      return c.json(
        { success: false, message: '协议版本已更新，请刷新后重新确认', currentVersion: current },
        409,
      );
    }
    try {
      recordConsent(version);
    } catch (err) {
      log.warn('record consent failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '保存失败，请检查服务器日志' }, 500);
    }
    consentGatePending = false; // unlock the rest of the API for this process
    log.info('agreements consent recorded (version=%s)', version);
    return c.json({ success: true, version });
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

  // ─── Background image (unauth, like /avatar) ─────────────────────────────
  // The login page needs to render the operator's background before auth, so
  // this route is intentionally public. It only serves a file the operator
  // themselves uploaded. Cache-busting is via the `?v=` version the client
  // appends; the bytes for a given version are immutable.
  app.get('/ui-asset/background', (c) => {
    const asset = readBackgroundImage();
    if (!asset) return c.text('no background', 404);
    return new Response(new Uint8Array(asset.bytes), {
      headers: {
        'Content-Type': asset.mime,
        'Cache-Control': 'public, max-age=31536000, immutable',
        // Defence-in-depth: never let an uploaded blob be interpreted as
        // anything but the sniffed image type.
        'X-Content-Type-Options': 'nosniff',
      },
    });
  });

  // ─── Read-only API ───────────────────────────────────────────────────────
  app.get('/api/status', (c) => c.json({ status: 'running' }));

  // Advisory update check — compares the running build against the latest
  // GitHub stable release and links the user to it. Read-only: SnowLuma
  // never downloads or applies the update itself. `?force=1` bypasses the
  // server-side cache (the "立即检查" button). Never errors out — a failed
  // check returns `{ hasUpdate: false, error }` and the UI degrades quietly.
  app.get('/api/update/check', async (c) => {
    const force = c.req.query('force') === 'true' || c.req.query('force') === '1';
    return c.json(await getUpdateInfo(force));
  });

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
      archLabel: CACHED_ARCH_LABEL,
      release: os.release(),
      distro: CACHED_DISTRO,
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

  // ── System settings (WebUI listener) — Wave A1 ──
  // Listener-level changes (port/host/TLS) are persisted but apply only on the
  // next restart (no supervisor → no self-restart). The panel surfaces which
  // fields are currently overridden by env so edits that won't take effect are
  // visible.
  const SYSTEM_CERT_PATH = path.join('config', 'cert.pem');
  const SYSTEM_KEY_PATH = path.join('config', 'key.pem');
  const hasCert = (): boolean => existsSync(SYSTEM_CERT_PATH) && existsSync(SYSTEM_KEY_PATH);

  app.get('/api/system/settings', (c) => {
    const disk = readRuntimeConfig();
    const envOverrides = Object.keys(resolveRuntimeEnvOverrides(process.env));
    return c.json({
      settings: {
        webuiPort: disk.webuiPort,
        webuiHost: disk.webuiHost,
        tlsEnabled: disk.webuiTls?.enabled ?? false,
        trustProxy: disk.trustProxy ?? '',
      },
      hasCert: hasCert(),
      envOverrides, // field names currently pinned by SNOWLUMA_* env vars
      listeningPort: boundPort,
      restartRequiredToApply: true,
    });
  });

  app.post('/api/system/settings', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    const coerced = coerceSettingsPatch(body);
    if (!coerced.ok) return c.json({ success: false, message: coerced.error }, 400);
    // Enabling TLS without a usable cert would brick HTTPS on restart — block it.
    if (coerced.patch.webuiTls?.enabled && !resolveTlsContext('config').ok) {
      return c.json({ success: false, message: '启用 TLS 前请先上传有效的证书与私钥' }, 400);
    }
    const saved = updateRuntimeConfig(coerced.patch);
    return c.json({
      success: true,
      settings: {
        webuiPort: saved.webuiPort,
        webuiHost: saved.webuiHost,
        tlsEnabled: saved.webuiTls?.enabled ?? false,
        trustProxy: saved.trustProxy ?? '',
      },
      restartRequiredToApply: true,
    });
  });

  app.post('/api/system/tls/cert', async (c) => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    const cert = (body as { cert?: unknown }).cert;
    const key = (body as { key?: unknown }).key;
    if (typeof cert !== 'string' || typeof key !== 'string') {
      return c.json({ success: false, message: 'cert 和 key 必须为 PEM 字符串' }, 400);
    }
    const valid = validateTlsPair(cert, key);
    if (!valid.ok) return c.json({ success: false, message: valid.reason }, 400);
    try {
      mkdirSync('config', { recursive: true });
      writeFileSync(SYSTEM_CERT_PATH, cert.endsWith('\n') ? cert : cert + '\n', 'utf8');
      // Private key must not be world-readable (mirrors auth.ts's webui.json
      // 0600). writeFileSync's mode is ignored for an existing file, so chmod
      // explicitly afterwards.
      writeFileSync(SYSTEM_KEY_PATH, key.endsWith('\n') ? key : key + '\n', { encoding: 'utf8', mode: 0o600 });
      // Best-effort (mirrors auth.ts): the key is already written 0600 above, so
      // a rare chmod failure must not fail the request.
      try { chmodSync(SYSTEM_KEY_PATH, 0o600); } catch { /* best-effort */ }
    } catch (err) {
      log.warn('write cert/key failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '写入证书失败，请检查服务器日志' }, 500);
    }
    return c.json({ success: true, restartRequiredToApply: true });
  });

  app.delete('/api/system/tls/cert', (c) => {
    try {
      rmSync(SYSTEM_CERT_PATH, { force: true });
      rmSync(SYSTEM_KEY_PATH, { force: true });
    } catch (err) {
      log.warn('remove cert/key failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '删除证书失败' }, 500);
    }
    return c.json({ success: true });
  });

  // ── Config backup / restore (Wave A2) ──
  const cfgPath = (name: string) => path.join('config', name);
  const readCfg = (name: string): Buffer | null => {
    const p = cfgPath(name);
    return existsSync(p) ? readFileSync(p) : null;
  };

  const listPerUinOnebot = (): string[] => {
    try {
      return existsSync('config') ? readdirSync('config').filter((n) => /^onebot_\d+\.json$/.test(n)) : [];
    } catch { return []; }
  };

  app.get('/api/system/backup/export', (c) => {
    const includeCredentials = c.req.query('credentials') === '1';
    const ts = new Date().toISOString();
    const bundle = buildBackup(readCfg, listPerUinOnebot(), { includeCredentials }, ts);
    c.header('Content-Disposition', `attachment; filename="snowluma-backup-${ts.replace(/[:.]/g, '-')}.json"`);
    // Bundle may carry the TLS private key / password hash — never cache it.
    c.header('Cache-Control', 'no-store, max-age=0');
    c.header('Pragma', 'no-cache');
    return c.json(bundle);
  });

  app.post('/api/system/backup/import', async (c) => {
    const declaredLen = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > 32 * 1024 * 1024) {
      return c.json({ success: false, message: '备份文件过大' }, 413);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    if (typeof body !== 'object' || body === null) {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    const { backup, restoreCredentials } = body as { backup?: unknown; restoreCredentials?: unknown };
    const v = validateBackup(backup);
    if (!v.ok) return c.json({ success: false, message: v.error }, 400);

    const plan = planRestore(v.backup, { restoreCredentials: restoreCredentials === true });
    // Snapshot the current (about-to-be-overwritten) config so a restore is
    // recoverable; one timestamped dir per import.
    const snapDir = path.join('config', `.restore-backup-${new Date().toISOString().replace(/[:.]/g, '-')}`);
    // Two-phase write for near-atomicity: stage every file as a .tmp first, then
    // rename them all. A failure during staging touches no live file; rename
    // almost never fails, shrinking the half-applied window to near zero.
    const staged: Array<{ tmp: string; dest: string; name: string }> = [];
    try {
      for (const { name } of plan.restore) {
        const src = cfgPath(name);
        if (!existsSync(src)) continue;
        const snap = path.join(snapDir, name);
        mkdirSync(path.dirname(snap), { recursive: true });
        copyFileSync(src, snap);
      }
      for (const { name, data } of plan.restore) {
        const dest = cfgPath(name);
        mkdirSync(path.dirname(dest), { recursive: true });
        const tmp = dest + '.restore.tmp';
        writeFileSync(tmp, data, name === 'key.pem' ? { mode: 0o600 } : undefined);
        staged.push({ tmp, dest, name });
      }
      for (const { tmp, dest, name } of staged) {
        renameSync(tmp, dest);
        if (name === 'key.pem') { try { chmodSync(dest, 0o600); } catch { /* best-effort */ } }
      }
      return c.json({
        success: true,
        restored: plan.restore.map((r) => r.name),
        skipped: plan.skipped,
        snapshotDir: snapDir,
        restartRequiredToApply: true,
      });
    } catch (err) {
      // Clean up any staged .tmp not yet renamed (staging-phase failure leaves
      // the live config untouched; a rare rename-phase failure may be partial,
      // recoverable from the snapshot dir).
      for (const { tmp } of staged) { try { if (existsSync(tmp)) rmSync(tmp, { force: true }); } catch { /* ignore */ } }
      log.warn('backup import failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '恢复失败；若为写入阶段失败则当前配置未改动，否则可从 config/.restore-backup-* 快照恢复' }, 500);
    }
  });

  // ── Debug tools (Wave A3) ──
  // Action schemas for the tester form (declarative actions only; legacy ones
  // are invoked freeform).
  app.get('/api/debug/actions', (c) =>
    c.json({ actions: collectActionDocs(), categories: collectCategories() }));

  // Manually invoke an action against one account. Real side effects — gated by
  // the same /api/* auth.
  app.post('/api/debug/invoke', async (c) => {
    let body: unknown;
    try { body = await c.req.json(); } catch { return c.json({ status: 'failed', message: '请求格式错误' }, 400); }
    const { uin, action, params } = (body ?? {}) as { uin?: unknown; action?: unknown; params?: unknown };
    if (typeof uin !== 'string' || !UIN_REGEX.test(uin)) return c.json({ status: 'failed', message: '无效的账号' }, 400);
    if (typeof action !== 'string' || !action) return c.json({ status: 'failed', message: 'action 必填' }, 400);
    if (params !== undefined && (typeof params !== 'object' || params === null || Array.isArray(params))) {
      return c.json({ status: 'failed', message: 'params 必须是对象' }, 400);
    }
    const inst = oneBotManager.getInstance(uin);
    if (!inst) return c.json({ status: 'failed', message: '账号不在线' }, 404);
    const result = await inst.invokeAction(action, (params ?? {}) as OneBotJsonObject);
    return c.json(result);
  });

  // Live merged SSE of OneBot events + action calls across all accounts. Taps
  // are attached only while a client is connected (on-demand). A slow client is
  // dropped (not back-pressured onto the bot) with a periodic drop marker.
  app.get('/api/debug/stream', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        const offs: Array<() => void> = [];
        let heartbeat: NodeJS.Timeout | undefined;
        const teardown = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          for (const off of offs) { try { off(); } catch { /* ignore */ } }
          try { controller.close(); } catch { /* ignore */ }
        };
        const raw = (chunk: Uint8Array) => {
          if (closed) return;
          try { controller.enqueue(chunk); } catch { teardown(); }
        };
        // Drop-under-backpressure framing (unit-tested in debug-stream.ts).
        const pushFrame = createFramePusher({
          desiredSize: () => controller.desiredSize,
          enqueue: raw,
          encode: (s) => encoder.encode(s),
        });
        const send = (payload: unknown) => { if (!closed) pushFrame(payload); };
        send({ kind: 'ready' });
        for (const inst of oneBotManager.getInstances()) {
          const uin = inst.uin;
          offs.push(inst.subscribeDebugEvents((event) => send({ kind: 'event', uin, event })));
          offs.push(inst.observeActions((rec) => send({ kind: 'action', uin, ...rec })));
        }
        heartbeat = setInterval(() => raw(encoder.encode(': heartbeat\n\n')), 15000);
        c.req.raw.signal.addEventListener('abort', teardown);
      },
    });
    return new Response(stream, {
      headers: { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' },
    });
  });

  app.get('/api/qq-list', (c) => {
    const instances = oneBotManager.getInstances();
    const list = instances.map((inst) => ({ uin: inst.uin, nickname: inst.nickname }));
    return c.json({ list });
  });

  // Live OneBot adapter health per account (listening / connected / client
  // counts / last-delivery), powering the dashboard's connection card.
  app.get('/api/connections', (c) => {
    return c.json({ list: oneBotManager.getConnectionStatuses() });
  });

  app.get('/api/logs', (c) => {
    const limit = Number(c.req.query('limit') ?? 300);
    return c.json({ list: getRecentLogs(limit) });
  });

  app.get('/api/logs/level', (c) => {
    return c.json({ level: getLogLevel(), levels: [...LOG_LEVELS] });
  });

  app.post('/api/logs/level', async (c) => {
    const body = await c.req.json().catch(() => null) as { level?: unknown } | null;
    const next = typeof body?.level === 'string' ? body.level : '';
    if (!setLogLevel(next)) {
      return c.json({ message: `invalid level: ${next}`, levels: [...LOG_LEVELS] }, 400);
    }
    log.info('console log level set to %s via WebUI', getLogLevel());
    return c.json({ level: getLogLevel(), levels: [...LOG_LEVELS] });
  });

  app.get('/api/logs/stream', (c) => {
    const stream = new ReadableStream({
      start(controller) {
        const encoder = new TextEncoder();
        let closed = false;
        let unsubscribe: (() => void) | undefined;
        let heartbeat: NodeJS.Timeout | undefined;
        const teardown = () => {
          if (closed) return;
          closed = true;
          if (heartbeat) clearInterval(heartbeat);
          unsubscribe?.();
          try { controller.close(); } catch { /* ignore */ }
        };
        const safeEnqueue = (chunk: Uint8Array) => {
          if (closed) return;
          try {
            controller.enqueue(chunk);
          } catch {
            // The peer dropped between abort and the next enqueue —
            // treat as end-of-stream so we don't leak listeners.
            teardown();
          }
        };
        const send = (event: unknown) => {
          safeEnqueue(encoder.encode(`data: ${JSON.stringify(event)}\n\n`));
        };
        send({ type: 'ready' });
        unsubscribe = subscribeLogs((entry) => send(entry));
        heartbeat = setInterval(() => {
          safeEnqueue(encoder.encode(': heartbeat\n\n'));
        }, 15000);
        c.req.raw.signal.addEventListener('abort', teardown);
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

  // Per-process action handler. The three routes below differ only in
  // which HookManager method they call.
  const MAX_PID = 4_194_304;
  function processAction(label: string, action: (pid: number) => Promise<HookProcessInfo>) {
    return async (c: Context) => {
      if (!hookManager) return c.json({ success: false, message: 'hook manager is not available' }, 503);
      const pid = Number(c.req.param('pid'));
      if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) {
        return c.json({ success: false, message: 'invalid pid' }, 400);
      }
      try {
        const processInfo = await action(pid);
        return c.json({ success: processInfo.status !== 'error', process: processInfo });
      } catch (err) {
        log.warn('%s pid=%d failed: %s', label, pid, err instanceof Error ? err.message : String(err));
        return c.json({ success: false, message: '操作失败，请检查服务器日志' }, 500);
      }
    };
  }
  app.post('/api/processes/:pid/load', processAction('load', (pid) => hookManager!.loadProcess(pid)));
  app.post('/api/processes/:pid/unload', processAction('unload', (pid) => hookManager!.unloadProcess(pid)));
  app.post('/api/processes/:pid/refresh', processAction('refresh', (pid) => hookManager!.refreshProcess(pid)));

  app.get('/api/processes/:pid/probe-login', async (c) => {
    if (!hookManager) return c.json({ info: null, message: 'hook manager is not available' }, 503);
    const pid = Number(c.req.param('pid'));
    if (!Number.isInteger(pid) || pid <= 0 || pid > MAX_PID) {
      return c.json({ info: null, message: 'invalid pid' }, 400);
    }
    try {
      const info = await hookManager.probeProcessLoginInfo(pid);
      return c.json({ info });
    } catch (err) {
      log.warn('probe-login pid=%d failed: %s', pid, err instanceof Error ? err.message : String(err));
      return c.json({ info: null, message: '探测失败' }, 500);
    }
  });

  app.get('/api/config/:uin', (c) => {
    const uin = c.req.param('uin');
    if (!UIN_REGEX.test(uin)) return c.json({ message: 'invalid uin' }, 400);
    // Read-only: never write defaults to disk on a GET. The persisted
    // file is created when manager.onSessionStarted boots an instance
    // or when the operator POSTs from this very endpoint.
    const config = loadOneBotConfig(uin);
    return c.json({ config });
  });

  app.post('/api/config/:uin', async (c) => {
    const uin = c.req.param('uin');
    if (!UIN_REGEX.test(uin)) return c.json({ success: false, message: 'invalid uin' }, 400);
    try {
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
      log.warn('save config for uin=%s failed: %s', uin, err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '配置保存失败，请检查服务器日志' }, 400);
    }
  });

  // ─── Notifications (account up/down → webhook) ───────────────────────────
  // Global channel store (config/notifications.json); per-UIN opt-in lives in
  // OneBotConfig.notifications.channelIds. All bearer-gated — channel URLs can
  // embed secrets, so none of this is exposed unauthenticated.
  app.get('/api/notifications/config', (c) => c.json({ config: loadNotificationsConfig() }));

  app.post('/api/notifications/config', async (c) => {
    const declaredLen = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > 512 * 1024) {
      return c.json({ success: false, message: '配置过大' }, 413);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    try {
      const config = saveNotificationsConfig(body);
      return c.json({ success: true, config });
    } catch (err) {
      log.warn('save notifications config failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '保存失败，请检查服务器日志' }, 500);
    }
  });

  app.get('/api/notifications/recent', (c) => {
    if (!notificationManager) return c.json({ recent: [] });
    const limitRaw = Number(c.req.query('limit'));
    const limit = Number.isFinite(limitRaw) && limitRaw > 0 ? Math.min(Math.trunc(limitRaw), 100) : 100;
    return c.json({ recent: notificationManager.getRecent(limit) });
  });

  app.post('/api/notifications/test', async (c) => {
    if (!notificationManager) return c.json({ success: false, message: '通知子系统不可用' }, 503);
    let body: { channelId?: unknown };
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    const channelId = typeof body.channelId === 'string' ? body.channelId : '';
    if (!channelId) return c.json({ success: false, message: '缺少 channelId' }, 400);
    const result = await notificationManager.testSend(channelId);
    if (!result.found) return c.json({ success: false, message: '渠道不存在' }, 404);
    return c.json({
      success: result.ok,
      status: result.status,
      message: result.ok
        ? '测试发送成功'
        : `测试发送失败：${result.error ?? (result.status ? `HTTP ${result.status}` : '未知错误')}`,
    });
  });

  // ─── WebUI customization config (config/ui.json) ─────────────────────────
  // Appearance (A) + layout (C). The full config is bearer-gated; only the
  // cosmetic appearance subset is exposed unauthenticated for the login page.
  app.get('/api/ui', (c) => c.json({ config: loadUiConfig() }));

  app.get('/api/ui/public', (c) => c.json({ appearance: publicAppearance() }));

  app.post('/api/ui', async (c) => {
    // Reject oversized bodies before buffering — the normalizer caps individual
    // fields (customCss 50KB, per-widget config 4KB) but not the whole payload.
    const declaredLen = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > 256 * 1024) {
      return c.json({ success: false, message: '配置过大' }, 413);
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json({ success: false, message: '请求格式错误' }, 400);
    }
    try {
      const config = saveUiConfig(body);
      return c.json({ success: true, config });
    } catch (err) {
      log.warn('save ui.json failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '保存失败，请检查服务器日志' }, 400);
    }
  });

  app.post('/api/ui/background', async (c) => {
    // Early reject by Content-Length BEFORE parseBody() buffers the whole
    // multipart body into memory — otherwise a multi-GB upload is fully
    // materialized before the post-parse size check fires. The slack covers
    // the multipart envelope (boundary + part headers); the exact decoded
    // size is still enforced below. A chunked request with no Content-Length
    // skips this coarse guard, but the endpoint is bearer-gated to the single
    // admin, so that residual is acceptable.
    const declaredLen = Number(c.req.header('content-length'));
    if (Number.isFinite(declaredLen) && declaredLen > MAX_BACKGROUND_BYTES + 1024 * 1024) {
      return c.json({ success: false, message: '图片过大（上限 5MB）' }, 413);
    }
    let file: unknown;
    try {
      const form = await c.req.parseBody();
      file = form['file'];
    } catch {
      return c.json({ success: false, message: '上传解析失败' }, 400);
    }
    if (!(file instanceof File)) {
      return c.json({ success: false, message: '缺少图片文件' }, 400);
    }
    if (file.size > MAX_BACKGROUND_BYTES) {
      return c.json({ success: false, message: '图片过大（上限 5MB）' }, 413);
    }
    const bytes = new Uint8Array(await file.arrayBuffer());
    const mime = sniffImageMime(bytes);
    if (!mime) {
      return c.json({ success: false, message: '仅支持 PNG / JPEG / WebP 图片' }, 415);
    }
    try {
      const config = writeBackgroundImage(bytes, mime);
      return c.json({ success: true, config });
    } catch (err) {
      log.warn('write background image failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '保存图片失败，请检查服务器日志' }, 500);
    }
  });

  app.delete('/api/ui/background', (c) => {
    try {
      const config = clearBackgroundImage();
      return c.json({ success: true, config });
    } catch (err) {
      log.warn('clear background image failed: %s', err instanceof Error ? err.message : String(err));
      return c.json({ success: false, message: '删除图片失败' }, 500);
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
    if (
      c.req.path.startsWith('/api/') ||
      c.req.path.startsWith('/avatar/') ||
      c.req.path.startsWith('/ui-asset/')
    ) {
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
  boundPort = finalPort;

  const host = listener.host || '0.0.0.0';

  // TLS: only when explicitly enabled AND the on-disk cert/key load. A bad
  // or missing cert must never brick the WebUI — fall back to HTTP + warn.
  let tlsServe: { createServer: typeof createHttpsServer; serverOptions: { cert: Buffer; key: Buffer } } | undefined;
  let scheme = 'http';
  if (listener.tlsEnabled) {
    const tls = resolveTlsContext('config');
    if (tls.ok && tls.cert && tls.key) {
      tlsServe = { createServer: createHttpsServer, serverOptions: { cert: tls.cert, key: tls.key } };
      scheme = 'https';
    } else {
      log.warn('TLS enabled but cert/key unusable (%s) — serving over HTTP instead', tls.reason);
    }
  }

  await new Promise<void>((resolve) => {
    serve({ fetch: app.fetch, port: finalPort, hostname: host, ...(tlsServe ?? {}) }, (info) => {
      log.info(`listening ${scheme}://${host}:${info.port}`);
      resolve();
    });
  });
  return { port: finalPort };
}
