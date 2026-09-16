// Minimal SMTP client for notification-channel email. Runtime ships with no
// npm dependencies, so this speaks the protocol over node:net / node:tls
// (EHLO, optional STARTTLS, AUTH PLAIN/LOGIN, DATA). No extra features.

import net from 'node:net';
import tls from 'node:tls';

const CRLF = '\r\n';
const DEFAULT_TIMEOUT_MS = 15_000;

export class SmtpError extends Error {
  readonly responseCode?: number;
  readonly code?: string;

  constructor(message: string, opts?: { responseCode?: number; code?: string }) {
    super(message);
    this.name = 'SmtpError';
    this.responseCode = opts?.responseCode;
    this.code = opts?.code;
  }
}

export interface SmtpMail {
  host: string;
  port: number;
  secure: boolean;
  user?: string;
  pass?: string;
  from: string;
  to: string[];
  subject: string;
  body: string;
}

export interface SendSmtpOptions {
  timeoutMs?: number;
  /** Defaults true. Tests against a self-signed mock pass false. */
  rejectUnauthorized?: boolean;
}

export function looksLikeEmail(value: string): boolean {
  return /^[^\s<>@]+@[^\s<>@]+$/.test(value);
}

/** Address from `Name <user@host>` or a bare addr; null if neither is usable. */
export function extractAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const angled = /<([^<>]+)>/.exec(trimmed);
  const addr = (angled ? angled[1] : trimmed).trim();
  return looksLikeEmail(addr) ? addr : null;
}

/** Split a comma / semicolon / newline list and keep unique addresses. */
export function parseRecipients(value: string): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const part of value.split(/[,;\n]+/)) {
    const addr = extractAddress(part);
    if (!addr) continue;
    const key = addr.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(addr);
  }
  return out;
}

function encodeHeader(value: string): string {
  if (/^[\x20-\x7E]*$/.test(value) && !/[\r\n]/.test(value)) return value;
  return `=?UTF-8?B?${Buffer.from(value, 'utf8').toString('base64')}?=`;
}

function rfc5322Date(d: Date): string {
  return d.toUTCString().replace(/GMT$/, '+0000');
}

function wrap76(b64: string): string {
  return b64.replace(/.{1,76}/g, (line) => `${line}\r\n`).trimEnd();
}

function isHtmlBody(body: string): boolean {
  return /^\s*</.test(body);
}

function dotStuff(payload: string): string {
  return payload.replace(/^\./gm, '..');
}

/** Build a single-part MIME message (plain or HTML). Exported for tests. */
export function buildMimeMessage(mail: SmtpMail, now = new Date()): string {
  const fromAddr = extractAddress(mail.from);
  const toHeader = mail.to.join(', ');
  const html = isHtmlBody(mail.body);
  const id = `<${now.getTime()}.${Math.random().toString(36).slice(2, 10)}@snowluma>`;
  const headers = [
    `From: ${mail.from.trim() || (fromAddr ? `<${fromAddr}>` : '')}`,
    `To: ${toHeader}`,
    `Subject: ${encodeHeader(mail.subject)}`,
    `Date: ${rfc5322Date(now)}`,
    `Message-ID: ${id}`,
    'MIME-Version: 1.0',
    `Content-Type: ${html ? 'text/html' : 'text/plain'}; charset=UTF-8`,
    'Content-Transfer-Encoding: base64',
  ];
  const body = wrap76(Buffer.from(mail.body, 'utf8').toString('base64'));
  return `${headers.join(CRLF)}${CRLF}${CRLF}${body}${CRLF}`;
}

interface SmtpReply {
  code: number;
  lines: string[];
  text: string;
}

function consumeReply(buf: string): { reply: SmtpReply; rest: string } | null {
  let offset = 0;
  const lines: string[] = [];
  let code = 0;
  while (offset < buf.length) {
    const nl = buf.indexOf('\n', offset);
    if (nl === -1) return null;
    const line = buf.slice(offset, nl).replace(/\r$/, '');
    offset = nl + 1;
    const m = /^(\d{3})([ -])(.*)$/.exec(line);
    if (!m) continue;
    code = Number(m[1]);
    lines.push(m[3]);
    if (m[2] === ' ') {
      return { reply: { code, lines, text: lines.join('\n') }, rest: buf.slice(offset) };
    }
  }
  return null;
}

type SmtpSock = net.Socket | tls.TLSSocket;

function parseCapabilities(reply: SmtpReply): { starttls: boolean; auth: Set<string> } {
  const auth = new Set<string>();
  let starttls = false;
  for (const line of reply.lines) {
    const u = line.toUpperCase();
    if (u === 'STARTTLS' || u.startsWith('STARTTLS ')) starttls = true;
    if (u.startsWith('AUTH ')) {
      for (const mech of u.slice(5).split(/\s+/)) {
        if (mech) auth.add(mech);
      }
    }
  }
  return { starttls, auth };
}

function connectSocket(
  host: string,
  port: number,
  secure: boolean,
  timeoutMs: number,
  rejectUnauthorized: boolean,
): Promise<SmtpSock> {
  return new Promise((resolve, reject) => {
    const sock: SmtpSock = secure
      ? tls.connect({
        host,
        port,
        servername: net.isIP(host) === 0 ? host : undefined,
        rejectUnauthorized,
      })
      : net.connect({ host, port });
    const fail = (err: Error) => {
      sock.destroy();
      reject(err);
    };
    sock.setTimeout(timeoutMs);
    sock.once('timeout', () => fail(new SmtpError('SMTP connection timed out', { code: 'ETIMEDOUT' })));
    sock.once('error', fail);
    sock.once(secure ? 'secureConnect' : 'connect', () => {
      sock.removeAllListeners('timeout');
      sock.removeAllListeners('error');
      resolve(sock);
    });
  });
}

function upgradeTls(
  socket: net.Socket,
  host: string,
  timeoutMs: number,
  rejectUnauthorized: boolean,
): Promise<tls.TLSSocket> {
  return new Promise((resolve, reject) => {
    const tlsSocket = tls.connect({
      socket,
      servername: net.isIP(host) === 0 ? host : undefined,
      rejectUnauthorized,
    }, () => resolve(tlsSocket));
    tlsSocket.setTimeout(timeoutMs);
    tlsSocket.once('timeout', () => {
      tlsSocket.destroy();
      reject(new SmtpError('SMTP STARTTLS timed out', { code: 'ETIMEDOUT' }));
    });
    tlsSocket.once('error', reject);
  });
}

class SmtpSession {
  private buf = '';

  constructor(private socket: SmtpSock) {}

  destroy(): void {
    this.socket.destroy();
  }

  attachTimeout(timeoutMs: number, onTimeout: () => void): void {
    this.socket.setTimeout(timeoutMs);
    this.socket.once('timeout', onTimeout);
  }

  async read(): Promise<SmtpReply> {
    const ready = consumeReply(this.buf);
    if (ready) {
      this.buf = ready.rest;
      return ready.reply;
    }
    return new Promise<SmtpReply>((resolve, reject) => {
      const onData = (chunk: Buffer) => {
        this.buf += chunk.toString('utf8');
        const got = consumeReply(this.buf);
        if (!got) return;
        this.buf = got.rest;
        cleanup();
        resolve(got.reply);
      };
      const onError = (err: Error) => {
        cleanup();
        reject(err);
      };
      const onClose = () => {
        cleanup();
        reject(new SmtpError('SMTP connection closed'));
      };
      const cleanup = () => {
        this.socket.removeListener('data', onData);
        this.socket.removeListener('error', onError);
        this.socket.removeListener('close', onClose);
      };
      this.socket.on('data', onData);
      this.socket.once('error', onError);
      this.socket.once('close', onClose);
    });
  }

  write(data: string): void {
    this.socket.write(data);
  }

  async command(line: string, ok: (code: number) => boolean, label?: string): Promise<SmtpReply> {
    this.write(line + CRLF);
    const reply = await this.read();
    if (!ok(reply.code)) {
      const name = label ?? line.split(' ')[0] ?? 'SMTP';
      throw new SmtpError(`${name} failed: ${reply.code} ${reply.text}`.trim(), {
        responseCode: reply.code,
      });
    }
    return reply;
  }

  replaceSocket(next: SmtpSock): void {
    this.socket = next;
    this.buf = '';
  }
}

export function formatSmtpError(err: unknown, host: string, port: number): string {
  if (err instanceof SmtpError) {
    if (err.code === 'ECONNREFUSED' || err.code === 'ENOTFOUND' || err.code === 'ETIMEDOUT') {
      return `无法连接 SMTP：${host}:${port}`;
    }
    if (err.responseCode === 535) return 'SMTP 认证失败';
    return err.message;
  }
  if (err instanceof Error) {
    const code = (err as NodeJS.ErrnoException).code;
    if (code === 'ECONNREFUSED' || code === 'ENOTFOUND' || code === 'ETIMEDOUT') {
      return `无法连接 SMTP：${host}:${port}`;
    }
    if (/self-signed|unable to verify/i.test(err.message)) {
      return `SMTP 证书不受信任：${host}`;
    }
    return err.message || '邮件发送失败';
  }
  return '邮件发送失败';
}

export async function sendSmtpMail(mail: SmtpMail, opts: SendSmtpOptions = {}): Promise<void> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const rejectUnauthorized = opts.rejectUnauthorized ?? true;
  const fromAddr = extractAddress(mail.from);
  if (!fromAddr) throw new SmtpError('invalid from address');
  if (mail.to.length === 0) throw new SmtpError('no recipients');

  let sock = await connectSocket(mail.host, mail.port, mail.secure, timeoutMs, rejectUnauthorized);
  const session = new SmtpSession(sock);
  let finished = false;
  const failTimeout = () => {
    if (finished) return;
    session.destroy();
  };
  session.attachTimeout(timeoutMs, failTimeout);

  try {
    const greeting = await session.read();
    if (greeting.code !== 220) {
      throw new SmtpError(`SMTP greeting failed: ${greeting.code} ${greeting.text}`.trim(), {
        responseCode: greeting.code,
      });
    }

    const ehlo = async () => session.command('EHLO [127.0.0.1]', (c) => c === 250);
    let caps = parseCapabilities(await ehlo());

    if (!mail.secure && caps.starttls) {
      await session.command('STARTTLS', (c) => c === 220);
      const upgraded = await upgradeTls(sock as net.Socket, mail.host, timeoutMs, rejectUnauthorized);
      session.replaceSocket(upgraded);
      session.attachTimeout(timeoutMs, failTimeout);
      sock = upgraded;
      caps = parseCapabilities(await ehlo());
    }

    const user = mail.user?.trim() ?? '';
    if (user) {
      await authenticate(session, caps.auth, user, mail.pass ?? '');
    }

    await session.command(`MAIL FROM:<${fromAddr}>`, (c) => c === 250);
    for (const rcpt of mail.to) {
      await session.command(`RCPT TO:<${rcpt}>`, (c) => c === 250 || c === 251);
    }
    await session.command('DATA', (c) => c === 354);
    session.write(dotStuff(buildMimeMessage(mail)));
    await session.command('.', (c) => c === 250, 'DATA');
    try {
      await session.command('QUIT', (c) => c === 221);
    } catch {
      // Some relays drop the socket after 250; delivery already succeeded.
    }
    finished = true;
  } catch (err) {
    finished = true;
    throw err;
  } finally {
    session.destroy();
  }
}

async function authenticate(
  session: SmtpSession,
  mechs: Set<string>,
  user: string,
  pass: string,
): Promise<void> {
  const hasPlain = mechs.has('PLAIN');
  const hasLogin = mechs.has('LOGIN');
  if (hasPlain || !hasLogin) {
    try {
      const token = Buffer.from(`\0${user}\0${pass}`, 'utf8').toString('base64');
      await session.command(`AUTH PLAIN ${token}`, (c) => c === 235, 'AUTH');
      return;
    } catch (err) {
      if (hasPlain && !hasLogin) throw err;
      if (err instanceof SmtpError && err.responseCode === 535) throw err;
    }
  }
  await loginAuth(session, user, pass);
}

async function loginAuth(session: SmtpSession, user: string, pass: string): Promise<void> {
  await session.command('AUTH LOGIN', (c) => c === 334, 'AUTH');
  await session.command(Buffer.from(user, 'utf8').toString('base64'), (c) => c === 334, 'AUTH');
  await session.command(Buffer.from(pass, 'utf8').toString('base64'), (c) => c === 235, 'AUTH');
}
