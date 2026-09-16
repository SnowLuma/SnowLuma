import { afterEach, describe, expect, it } from 'vitest';
import net from 'node:net';
import tls from 'node:tls';
import {
  buildMimeMessage,
  extractAddress,
  formatSmtpError,
  parseRecipients,
  sendSmtpMail,
  SmtpError,
} from '../src/notifications/smtp';

// Same throwaway pair as webui-tls.test.ts (CN=snowluma-test).
const CERT = `-----BEGIN CERTIFICATE-----
MIIDETCCAfmgAwIBAgIUNiu66PmcO6Do6cUaB92UKD8j3qYwDQYJKoZIhvcNAQEL
BQAwGDEWMBQGA1UEAwwNc25vd2x1bWEtdGVzdDAeFw0yNjA2MTgwNjIwMTZaFw0z
NjA2MTUwNjIwMTZaMBgxFjAUBgNVBAMMDXNub3dsdW1hLXRlc3QwggEiMA0GCSqG
SIb3DQEBAQUAA4IBDwAwggEKAoIBAQCm0sVJhqlG75gOFJVsUJOfR+oqvb9eSq4t
k5QItuwXr85E2mrzuKFnSzVVbi3VqqyN8t4otL11mGll2ANSjusmWN4hzpaOBBdX
bP4UNX/YA7oHId+QKbVicxJgxDE18aPTwaWullyw23LsMsij8T4nLk4eHiOkeRfi
uLinG1COe3gUGkCK4uyyMT4Vz+y+5Oj9dvoXYL/A/KmcNtq7JrX7F7qYnYsJKLZZ
aZeFyIGSE8ihb0k53iyJ3agWY+rMUD+p5J7pgIZzBd5dcZuI+KwixVKZgapG5n5R
ghrnN2ZAQFz13yTRXYmDYy42m4Ue73hMmmt1xVXyf+WVhvrD6pphAgMBAAGjUzBR
MB0GA1UdDgQWBBRW/HP12nj9fYMYNxa3jyqmnUigvTAfBgNVHSMEGDAWgBRW/HP1
2nj9fYMYNxa3jyqmnUigvTAPBgNVHRMBAf8EBTADAQH/MA0GCSqGSIb3DQEBCwUA
A4IBAQCijzVQ/jHNoqu6stvkkigUv2lTKrd1EHcTZLfzwQkmNv/hfY2EMobO/Qxs
FhmITreKFALJ/dUwTt0UTO00LV9whEgr2of4x8wwjZ9wRstY6uyRYBP85QC8+8mZ
zWlcf611HugrmpOWjWfEVmmxdI1m26YWTn52nZFPnJqDWg2+RlLJWl55lVotbXEZ
Fvas4Vcf2KOk0QwBQKvpt0BISeTIQhbT4GnducxSxyoXGeBQOjQNYb/vTpMn4F9U
IAxSsfs9WVoHKXOabK8GV89BCxWoRk4UaSahTq/2Vnbgt86tWibt3lA4y49+XhA2
6z7n9HgJAUKqhsDrYvZmM7/VZ2d5
-----END CERTIFICATE-----
`;
const KEY = `-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQCm0sVJhqlG75gO
FJVsUJOfR+oqvb9eSq4tk5QItuwXr85E2mrzuKFnSzVVbi3VqqyN8t4otL11mGll
2ANSjusmWN4hzpaOBBdXbP4UNX/YA7oHId+QKbVicxJgxDE18aPTwaWullyw23Ls
Msij8T4nLk4eHiOkeRfiuLinG1COe3gUGkCK4uyyMT4Vz+y+5Oj9dvoXYL/A/Kmc
Ntq7JrX7F7qYnYsJKLZZaZeFyIGSE8ihb0k53iyJ3agWY+rMUD+p5J7pgIZzBd5d
cZuI+KwixVKZgapG5n5RghrnN2ZAQFz13yTRXYmDYy42m4Ue73hMmmt1xVXyf+WV
hvrD6pphAgMBAAECggEAJ13+u4qhIMHCnrQBzPU42PImEt8DLXOvJcc5PFM6ZJ6S
rRHkAk60HAWV+OqOu2jS3o6NGYsJWJpWaPewVQev+zUmelDfm3TgsztfvBIh8K50
dGFsef81tB1WnWo++K1kzUBZ4ljOV9f5hz62tWVlFubo/Vd8bsA6wEB6Jskd2fls
ZOO0hJCb/M6IIwe3cWw4sb/YFTTLMUnVHM0aJfnQ/QH+uraRwecJMv118d0YBYVG
DsNmYqrv9TYNBh4P9mKv6/0x8zaKsJZVLAMwHztILHItOXBfxCbSDivGWVUGiDq2
NxEuBOgxzOelxEYzUzf7B6sjHoEeIL5wIKQbwUbmfwKBgQDZRLhucrMZPw7ous1t
igkO32p1ku7FRxm0/JAskc66oX61KLIYbZFM9N7nTXAEs8ZGhzUkdSgxNcdHWIdK
RI+6pd2FhhcKU1feEohlOHvZTXXEMhm61phWnN391GZXfwMKSpscqsu9kIix2jtw
4YrzKLx82EDDHcLfBh9AtArKywKBgQDEj+7UJp5wuqz9hj+gogXeq4Buv9be1u4u
HCJZMZzLCwVjvoqYw0n1afXP3057v8hQPGsBaxzQpOg7i1lYGGfuZ9T6T8fFrtqw
m/LJLHhMQxeyCEQi1/EoNewvVGSwBJkLOuOs8T2WmMXmOgdHbEYdzkKtT71jst6y
TeJ15hVuAwKBgBMK4t9LTkc4L6ZWOQsQvhp/mmUTq7m+sZIbUMeXP/c7kE9wcauS
btm/3ImJT/gZiZdE4nN/kTY+8GhgafsoZzCEuRWq2vocs+bS2QGGIdS55Uh826R0
ioWM2igVJaMljq6oO1AX6COFN3XfGraaDgOh3mNS0NpJEXtangKdxRRhAoGAP9SF
t/r6hJz6RDHuQ5mZ0l9bC5vciOy+19ZnCRPlWMIxc9ySYV05jSplmqVndSQoRnX4
QbOo3dBPYda0orj6Nx8cuFRkCTvo5GUgCFgakJlQ/o1UowQA2g/4rL35HHfBwzXS
bXzBhUADM+owJu9wLYmneWRlmhSh4MEOAz8+QkUCgYAw0fA1Im2/ftrA2Z2IENTi
U4cLXqeUeGJfXjIBklUmXhc4qrd/9V9eEHjackI/JI7Qhp/QfPWMXLudlSrppnNJ
+s3dVevEKosiZbf4qtTtlmR/IifuTKjK5O94KlBT+evxNsL4Hv0b0oTsVNnEfOOl
OUsvSYNSnfvl87tyLIxYLA==
-----END PRIVATE KEY-----
`;

interface MockOptions {
  secure?: boolean;
  starttls?: boolean;
  mechs?: string;
  failAuth?: boolean;
}

interface MockSmtp {
  port: number;
  commands: string[];
  data: string;
  close: () => Promise<void>;
}

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  while (closers.length > 0) {
    const close = closers.pop();
    if (close) await close();
  }
});

function attachSession(
  socket: net.Socket | tls.TLSSocket,
  opts: MockOptions,
  sink: MockSmtp,
  greet = true,
): void {
  let buf = '';
  let mode: 'cmd' | 'data' = 'cmd';
  let loginStep = 0;
  const write = (s: string) => socket.write(s);
  if (greet) write('220 mock ESMTP\r\n');
  socket.on('data', (chunk) => {
    buf += chunk.toString('utf8');
    if (mode === 'data') {
      const end = buf.indexOf('\r\n.\r\n');
      if (end === -1) return;
      sink.data = buf.slice(0, end);
      buf = buf.slice(end + 5);
      mode = 'cmd';
      write('250 OK\r\n');
      return;
    }
    while (true) {
      const nl = buf.indexOf('\n');
      if (nl === -1) break;
      const line = buf.slice(0, nl).replace(/\r$/, '');
      buf = buf.slice(nl + 1);
      if (loginStep > 0 && /^[A-Za-z0-9+/=]+$/.test(line)) {
        sink.commands.push('(b64)');
      } else if (line.startsWith('AUTH PLAIN ')) {
        sink.commands.push('AUTH PLAIN');
      } else {
        sink.commands.push(line);
      }
      if (line.toUpperCase().startsWith('EHLO')) {
        const extra = opts.starttls ? '250-STARTTLS\r\n' : '';
        write(`250-mock\r\n${extra}250 AUTH ${opts.mechs ?? 'PLAIN LOGIN'}\r\n`);
      } else if (line.toUpperCase() === 'STARTTLS' && opts.starttls && socket instanceof net.Socket) {
        write('220 Go ahead\r\n');
        socket.removeAllListeners('data');
        const tlsSock = new tls.TLSSocket(socket, { isServer: true, cert: CERT, key: KEY });
        attachSession(tlsSock, { ...opts, starttls: false }, sink, false);
        return;
      } else if (line.toUpperCase() === 'AUTH LOGIN') {
        loginStep = 1;
        write('334 VXNlcm5hbWU6\r\n');
      } else if (line.toUpperCase().startsWith('AUTH PLAIN')) {
        write(opts.failAuth ? '535 5.7.8 auth failed\r\n' : '235 2.7.0 OK\r\n');
      } else if (loginStep === 1 && /^[A-Za-z0-9+/=]+$/.test(line)) {
        loginStep = 2;
        write('334 UGFzc3dvcmQ6\r\n');
      } else if (loginStep === 2 && /^[A-Za-z0-9+/=]+$/.test(line)) {
        loginStep = 0;
        write(opts.failAuth ? '535 5.7.8 auth failed\r\n' : '235 2.7.0 OK\r\n');
      } else if (line.toUpperCase().startsWith('MAIL FROM:')) {
        write('250 OK\r\n');
      } else if (line.toUpperCase().startsWith('RCPT TO:')) {
        write('250 OK\r\n');
      } else if (line.toUpperCase() === 'DATA') {
        mode = 'data';
        write('354 End data with <CR><LF>.<CR><LF>\r\n');
      } else if (line.toUpperCase() === 'QUIT') {
        write('221 bye\r\n');
        socket.end();
      } else {
        write('250 OK\r\n');
      }
    }
  });
}

function listenMock(opts: MockOptions = {}): Promise<MockSmtp> {
  return new Promise((resolve, reject) => {
    const sink: MockSmtp = { port: 0, commands: [], data: '', close: async () => undefined };
    const onConn = (socket: net.Socket | tls.TLSSocket) => attachSession(socket, opts, sink);
    const server = opts.secure
      ? tls.createServer({ cert: CERT, key: KEY }, onConn)
      : net.createServer(onConn);
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      const addr = server.address();
      if (!addr || typeof addr === 'string') {
        reject(new Error('no port'));
        return;
      }
      sink.port = addr.port;
      sink.close = () => new Promise((res) => server.close(() => res()));
      closers.push(sink.close);
      resolve(sink);
    });
  });
}

describe('address helpers', () => {
  it('extracts a bare or angled address and rejects junk', () => {
    expect(extractAddress('bot@qq.com')).toBe('bot@qq.com');
    expect(extractAddress('SnowLuma <bot@qq.com>')).toBe('bot@qq.com');
    expect(extractAddress('not-an-email')).toBeNull();
    expect(extractAddress('')).toBeNull();
  });

  it('parses unique recipients from mixed separators', () => {
    expect(parseRecipients('a@x.com; b@x.com, a@x.com\nc@x.com')).toEqual([
      'a@x.com',
      'b@x.com',
      'c@x.com',
    ]);
    expect(parseRecipients('nope, also nope')).toEqual([]);
  });
});

describe('buildMimeMessage', () => {
  const base = {
    host: 'smtp.example.com',
    port: 465,
    secure: true,
    from: 'SnowLuma <bot@example.com>',
    to: ['ops@example.com'],
    subject: '账号offline：Alice (1)',
    body: 'hello',
  };

  it('encodes a non-ASCII subject and a plain body as base64', () => {
    const raw = buildMimeMessage(base, new Date('2026-09-16T01:00:00Z'));
    expect(raw).toContain('Content-Type: text/plain; charset=UTF-8');
    expect(raw).toContain('Subject: =?UTF-8?B?');
    expect(raw).toContain(Buffer.from('hello', 'utf8').toString('base64'));
    expect(raw).toContain('From: SnowLuma <bot@example.com>');
  });

  it('marks a body that starts with < as HTML', () => {
    const raw = buildMimeMessage({ ...base, body: '<p>hi</p>' });
    expect(raw).toContain('Content-Type: text/html; charset=UTF-8');
  });
});

describe('formatSmtpError', () => {
  it('maps connect failures and 535 without leaking the exception class name only', () => {
    expect(formatSmtpError(new SmtpError('x', { code: 'ECONNREFUSED' }), 'smtp.qq.com', 465))
      .toBe('无法连接 SMTP：smtp.qq.com:465');
    expect(formatSmtpError(new SmtpError('AUTH failed: 535', { responseCode: 535 }), 'h', 25))
      .toBe('SMTP 认证失败');
    expect(formatSmtpError(new SmtpError('MAIL FROM failed: 550 denied', { responseCode: 550 }), 'h', 25))
      .toBe('MAIL FROM failed: 550 denied');
  });
});

describe('sendSmtpMail — live mock', () => {
  const mail = {
    host: '127.0.0.1',
    from: 'bot@example.com',
    to: ['ops@example.com'],
    subject: 'offline',
    body: '账号下线',
    user: 'bot@example.com',
    pass: 'secret',
  };

  it('delivers over AUTH PLAIN on a plaintext socket', async () => {
    const mock = await listenMock({ mechs: 'PLAIN' });
    await sendSmtpMail({ ...mail, port: mock.port, secure: false });
    expect(mock.commands).toContain('AUTH PLAIN');
    expect(mock.commands.some((c) => c.startsWith('MAIL FROM:<bot@example.com>'))).toBe(true);
    expect(mock.commands.some((c) => c.startsWith('RCPT TO:<ops@example.com>'))).toBe(true);
    expect(mock.data).toContain('Subject: offline');
    expect(mock.data).toContain(Buffer.from('账号下线', 'utf8').toString('base64'));
    expect(mock.commands.join('\n')).not.toContain('secret');
  });

  it('falls back to AUTH LOGIN when PLAIN is not advertised', async () => {
    const mock = await listenMock({ mechs: 'LOGIN' });
    await sendSmtpMail({ ...mail, port: mock.port, secure: false });
    expect(mock.commands).toContain('AUTH LOGIN');
    expect(mock.data).toContain('Subject: offline');
  });

  it('rejects 535 without sending DATA', async () => {
    const mock = await listenMock({ mechs: 'PLAIN', failAuth: true });
    await expect(sendSmtpMail({ ...mail, port: mock.port, secure: false }))
      .rejects.toMatchObject({ name: 'SmtpError', responseCode: 535 });
    expect(mock.data).toBe('');
  });

  it('upgrades via STARTTLS then authenticates', async () => {
    const mock = await listenMock({ starttls: true, mechs: 'PLAIN' });
    await sendSmtpMail(
      { ...mail, port: mock.port, secure: false },
      { rejectUnauthorized: false },
    );
    expect(mock.commands).toContain('STARTTLS');
    expect(mock.commands).toContain('AUTH PLAIN');
    expect(mock.data).toContain('Subject: offline');
  });

  it('speaks implicit TLS when secure=true', async () => {
    const mock = await listenMock({ secure: true, mechs: 'PLAIN' });
    await sendSmtpMail(
      { ...mail, port: mock.port, secure: true },
      { rejectUnauthorized: false },
    );
    expect(mock.commands).toContain('AUTH PLAIN');
    expect(mock.data).toContain('Subject: offline');
  });
});
