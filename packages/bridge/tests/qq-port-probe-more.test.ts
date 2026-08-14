import { EventEmitter } from 'events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs } from '@snowluma/common/logger';

const execMock = vi.hoisted(() => vi.fn());
const httpGetMock = vi.hoisted(() => vi.fn());
const httpsGetMock = vi.hoisted(() => vi.fn());

vi.mock('child_process', () => ({ exec: execMock }));
vi.mock('http', () => ({
  default: { get: httpGetMock },
  get: httpGetMock,
}));
vi.mock('https', () => ({
  default: { get: httpsGetMock },
  get: httpsGetMock,
}));

import { probeQqLoginInfo } from '../src/qq-port-probe';

const originalPlatform = process.platform;
const EXEC_OPTIONS = { timeout: 1500, killSignal: 'SIGKILL' };
const PTLOGIN_HEADERS = {
  Host: 'localhost.ptlogin2.qq.com',
  Referer: 'https://xui.ptlogin2.qq.com/',
  Cookie: 'pt_local_token=0',
};

type ExecCallback = (error: Error | null, result?: { stdout: string; stderr: string }) => void;
type RequestLike = EventEmitter & { destroy: ReturnType<typeof vi.fn> };

function setPlatform(platform: string): void {
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
}

function mockExec(replies: Record<string, string | Error>): void {
  execMock.mockImplementation((command: string, _options: unknown, callback: ExecCallback) => {
    const reply = replies[command];
    if (reply === undefined) {
      callback(new Error(`unexpected command ${command}`));
      return;
    }
    if (reply instanceof Error) {
      callback(reply);
      return;
    }
    callback(null, { stdout: reply, stderr: '' });
  });
}

function execCommands(): string[] {
  return execMock.mock.calls.map((call) => String(call[0]));
}

function ssLine(port: number, pid: number, owner: 'comma' | 'paren' = 'comma'): string {
  const tag = owner === 'comma' ? `pid=${pid},fd=9` : `pid=${pid}`;
  return `LISTEN 0 128 127.0.0.1:${port} 0.0.0.0:* users:(("qq",${tag}))`;
}

function netstatLine(localAddr: string, pid: number): string {
  return `  TCP    ${localAddr}    0.0.0.0:0    LISTENING    ${pid}`;
}

function jsonp(accounts: unknown[]): string {
  return `ptui_getuins_CB(${JSON.stringify(accounts)});`;
}

function requestStub(): RequestLike {
  const req = new EventEmitter() as RequestLike;
  req.destroy = vi.fn();
  return req;
}

function replyBody(body: string | ReadonlyArray<string | Buffer>) {
  return (_url: string, _options: unknown, onResponse: (res: EventEmitter) => void): RequestLike => {
    const req = requestStub();
    const res = new EventEmitter();
    onResponse(res);
    const chunks = typeof body === 'string' ? [body] : body;
    for (const chunk of chunks) res.emit('data', chunk);
    res.emit('end');
    return req;
  };
}

function replyError(error: Error) {
  return (): RequestLike => {
    const req = requestStub();
    queueMicrotask(() => req.emit('error', error));
    return req;
  };
}

beforeEach(() => {
  execMock.mockReset();
  httpGetMock.mockReset();
  httpsGetMock.mockReset();
  setPlatform('linux');
});

afterEach(() => {
  setPlatform(originalPlatform);
  vi.useRealTimers();
});

describe('probeQqLoginInfo — unix listing', () => {
  it('returns null when ss cannot list sockets', async () => {
    mockExec({ 'ss -tlnp': new Error('ss: not found') });

    await expect(probeQqLoginInfo(3310)).resolves.toBeNull();
    expect(execCommands()).toEqual(['ss -tlnp']);
    expect(execMock.mock.calls[0]?.[1]).toEqual(EXEC_OPTIONS);
    expect(httpGetMock).not.toHaveBeenCalled();
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  it('reports a logged-out identity when the PID has no sockets and pgrep is below 6', async () => {
    mockExec({
      'ss -tlnp': 'State Recv-Q Send-Q Local Address:Port Peer Address:Port\n',
      'pgrep -c qq': '5\n',
    });

    await expect(probeQqLoginInfo(3311)).resolves.toEqual({
      port: 0,
      uin: '',
      identityKnown: false,
    });
    expect(execCommands()).toEqual(['ss -tlnp', 'pgrep -c qq']);
    expect(execMock.mock.calls[1]?.[1]).toEqual(EXEC_OPTIONS);
  });

  it('treats a pgrep count of 0 as logged out', async () => {
    mockExec({
      'ss -tlnp': '',
      'pgrep -c qq': '0\n',
    });

    await expect(probeQqLoginInfo(3312)).resolves.toEqual({
      port: 0,
      uin: '',
      identityKnown: false,
    });
  });

  it('treats a non-numeric pgrep count as 0 and therefore logged out', async () => {
    mockExec({
      'ss -tlnp': '',
      'pgrep -c qq': 'qq: no process found\n',
    });

    await expect(probeQqLoginInfo(3313)).resolves.toEqual({
      port: 0,
      uin: '',
      identityKnown: false,
    });
  });

  it('returns null when there are no sockets and pgrep is 6 or higher', async () => {
    mockExec({
      'ss -tlnp': '',
      'pgrep -c qq': '6\n',
    });
    await expect(probeQqLoginInfo(3314)).resolves.toBeNull();

    mockExec({
      'ss -tlnp': '',
      'pgrep -c qq': '9\n',
    });
    await expect(probeQqLoginInfo(3315)).resolves.toBeNull();
  });

  it('does not treat a failed pgrep as logged out', async () => {
    mockExec({
      'ss -tlnp': '',
      'pgrep -c qq': new Error('pgrep: exit 1'),
    });

    await expect(probeQqLoginInfo(3316)).resolves.toBeNull();
  });

  it('uses the first listening port as a logged-out hint when no Ptlogin port is present', async () => {
    mockExec({
      'ss -tlnp': [
        ssLine(9218, 4410),
        ssLine(18000, 4410),
      ].join('\n'),
      'pgrep -c qq': ' 4 \n',
    });

    await expect(probeQqLoginInfo(4410)).resolves.toEqual({
      port: 9218,
      uin: '',
      identityKnown: false,
    });
    expect(httpGetMock).not.toHaveBeenCalled();
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  it('returns null for non-Ptlogin ports when the QQ process count is ambiguous', async () => {
    mockExec({
      'ss -tlnp': ssLine(9218, 4411),
      'pgrep -c qq': '7\n',
    });

    await expect(probeQqLoginInfo(4411)).resolves.toBeNull();
    expect(httpGetMock).not.toHaveBeenCalled();
    expect(httpsGetMock).not.toHaveBeenCalled();
  });

  it('collects unique ports from ss lines that name the PID with either pid=N, or pid=N)', async () => {
    mockExec({
      'ss -tlnp': [
        'LISTEN 0 128 127.0.0.1:4301users:(("qq",pid=4412,fd=1))',
        ssLine(4301, 4412, 'comma'),
        ssLine(4301, 4412, 'comma'),
        ssLine(4305, 4412, 'paren'),
        ssLine(4305, 9999, 'comma'),
        'ESTAB 0 0 127.0.0.1:4307 127.0.0.1:443 users:(("qq",pid=4412,fd=4))',
      ].join('\n'),
    });
    httpsGetMock.mockImplementation(replyBody(jsonp([{ uin: '10001', nickname: 'Ada' }])));

    await expect(probeQqLoginInfo(4412)).resolves.toEqual({
      port: 4301,
      uin: '10001',
      nickName: 'Ada',
      identityKnown: true,
    });
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    expect(httpsGetMock.mock.calls[0]?.[0]).toBe(
      'https://127.0.0.1:4301/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0',
    );
  });
});

describe('probeQqLoginInfo — Ptlogin identity', () => {
  it('reads a single account from an odd Ptlogin port over https', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5501) });
    httpsGetMock.mockImplementation(replyBody(jsonp([{
      uin: 319427101,
      account: 1,
      nickname: 'Snow',
      extra: 'ignored',
    }])));

    await expect(probeQqLoginInfo(5501)).resolves.toEqual({
      port: 4301,
      uin: '319427101',
      nickName: 'Snow',
      identityKnown: true,
    });
    expect(httpGetMock).not.toHaveBeenCalled();
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    expect(httpsGetMock.mock.calls[0]?.[1]).toEqual({
      headers: PTLOGIN_HEADERS,
      timeout: 500,
      rejectUnauthorized: false,
    });
  });

  it('reads a single account from an even Ptlogin port over http', async () => {
    mockExec({ 'ss -tlnp': ssLine(4302, 5502) });
    httpGetMock.mockImplementation(replyBody(jsonp([{
      account: '2880036470',
    }])));

    await expect(probeQqLoginInfo(5502)).resolves.toEqual({
      port: 4302,
      uin: '2880036470',
      nickName: '',
      identityKnown: true,
    });
    expect(httpsGetMock).not.toHaveBeenCalled();
    expect(httpGetMock).toHaveBeenCalledTimes(2);
    expect(httpGetMock.mock.calls[0]?.[0]).toBe(
      'http://127.0.0.1:4302/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0',
    );
    expect(httpGetMock.mock.calls[0]?.[1]).toEqual({
      headers: PTLOGIN_HEADERS,
      timeout: 500,
    });
  });

  it('probes every documented odd Ptlogin port over https', async () => {
    for (const port of [4301, 4303, 4305, 4307, 4309]) {
      execMock.mockReset();
      httpsGetMock.mockReset();
      httpGetMock.mockReset();
      mockExec({ 'ss -tlnp': ssLine(port, 5510) });
      httpsGetMock.mockImplementation(replyBody(jsonp([{ uin: '70001', nickname: 'Odd' }])));

      await expect(probeQqLoginInfo(5510)).resolves.toEqual({
        port,
        uin: '70001',
        nickName: 'Odd',
        identityKnown: true,
      });
      expect(httpGetMock).not.toHaveBeenCalled();
      expect(String(httpsGetMock.mock.calls[0]?.[0])).toBe(
        `https://127.0.0.1:${port}/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0`,
      );
    }
  });

  it('probes every documented even Ptlogin port over http when no odd port is listening', async () => {
    for (const port of [4302, 4304, 4306, 4308, 4310]) {
      execMock.mockReset();
      httpsGetMock.mockReset();
      httpGetMock.mockReset();
      mockExec({ 'ss -tlnp': ssLine(port, 5511) });
      httpGetMock.mockImplementation(replyBody(jsonp([{ uin: '70002', nickname: 'Even' }])));

      await expect(probeQqLoginInfo(5511)).resolves.toEqual({
        port,
        uin: '70002',
        nickName: 'Even',
        identityKnown: true,
      });
      expect(httpsGetMock).not.toHaveBeenCalled();
      expect(String(httpGetMock.mock.calls[0]?.[0])).toBe(
        `http://127.0.0.1:${port}/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0`,
      );
    }
  });

  it('prefers odd Ptlogin ports and never falls through to even ones', async () => {
    mockExec({
      'ss -tlnp': [ssLine(4302, 5520), ssLine(4301, 5520)].join('\n'),
    });
    httpsGetMock.mockImplementation(replyError(new Error('ECONNREFUSED')));

    await expect(probeQqLoginInfo(5520)).resolves.toBeNull();
    expect(httpsGetMock).toHaveBeenCalled();
    expect(httpGetMock).not.toHaveBeenCalled();
    expect(execCommands()).toEqual(['ss -tlnp']);
  });

  it('tries the next odd Ptlogin port after the first one fails', async () => {
    mockExec({
      'ss -tlnp': [ssLine(4301, 5521), ssLine(4305, 5521)].join('\n'),
    });
    httpsGetMock
      .mockImplementationOnce(replyBody('<html>nope</html>'))
      .mockImplementationOnce(replyBody('<html>nope</html>'))
      .mockImplementationOnce(replyBody(jsonp([{ uin: '188888', nickname: 'Next' }])))
      .mockImplementationOnce(replyBody(jsonp([{ uin: '188888', nickname: 'Next' }])));

    await expect(probeQqLoginInfo(5521)).resolves.toEqual({
      port: 4305,
      uin: '188888',
      nickName: 'Next',
      identityKnown: true,
    });
    expect(httpsGetMock.mock.calls.map((call) => call[0])).toEqual([
      'https://127.0.0.1:4301/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0',
      'https://127.0.0.1:4301/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0',
      'https://127.0.0.1:4305/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0',
      'https://127.0.0.1:4305/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0',
    ]);
  });

  it('stops after the first Ptlogin port that yields a single account', async () => {
    mockExec({
      'ss -tlnp': [ssLine(4303, 5522), ssLine(4309, 5522)].join('\n'),
    });
    httpsGetMock.mockImplementation(replyBody(jsonp([{ uin: '42', nickname: 'First' }])));

    await expect(probeQqLoginInfo(5522)).resolves.toEqual({
      port: 4303,
      uin: '42',
      nickName: 'First',
      identityKnown: true,
    });
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
  });

  it('uses account when uin is missing or empty, including a numeric 0 uin', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5530) });
    httpsGetMock
      .mockImplementationOnce(replyBody(jsonp([{ uin: 0, account: 314159, nickname: 'Zero' }])))
      .mockImplementationOnce(replyBody(jsonp([{ uin: '', account: '314159', nickname: 'Zero' }])));

    await expect(probeQqLoginInfo(5530)).resolves.toEqual({
      port: 4301,
      uin: '314159',
      nickName: 'Zero',
      identityKnown: true,
    });
  });

  it('returns an empty uin when the single account has neither uin nor account', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5531) });
    httpsGetMock.mockImplementation(replyBody('[{"nickname":"Anon"}]'));

    await expect(probeQqLoginInfo(5531)).resolves.toEqual({
      port: 4301,
      uin: '',
      nickName: 'Anon',
      identityKnown: true,
    });
  });

  it('keeps the shorter of the two pt_get_uins snapshots', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5540) });
    httpsGetMock
      .mockImplementationOnce(replyBody(jsonp([
        { uin: '11', nickname: 'A' },
        { uin: '22', nickname: 'B' },
      ])))
      .mockImplementationOnce(replyBody(jsonp([{ uin: '33', nickname: 'Cora' }])));

    await expect(probeQqLoginInfo(5540)).resolves.toEqual({
      port: 4301,
      uin: '33',
      nickName: 'Cora',
      identityKnown: true,
    });
  });

  it('keeps the first snapshot when both pt_get_uins calls have one account', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5541) });
    httpsGetMock
      .mockImplementationOnce(replyBody(jsonp([{ uin: '100', nickname: 'Left' }])))
      .mockImplementationOnce(replyBody(jsonp([{ uin: '200', nickname: 'Right' }])));

    await expect(probeQqLoginInfo(5541)).resolves.toEqual({
      port: 4301,
      uin: '100',
      nickName: 'Left',
      identityKnown: true,
    });
  });

  it('accepts a single account from the second fetch when the first fetch is unusable', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5542) });
    httpsGetMock
      .mockImplementationOnce(replyError(new Error('ECONNRESET')))
      .mockImplementationOnce(replyBody(jsonp([{ uin: '9090', nickname: 'Retry' }])));

    await expect(probeQqLoginInfo(5542)).resolves.toEqual({
      port: 4301,
      uin: '9090',
      nickName: 'Retry',
      identityKnown: true,
    });
  });

  it('returns null for an empty pt_get_uins array and does not consult pgrep', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5550) });
    httpsGetMock.mockImplementation(replyBody('ptui_getuins_CB([]);'));

    await expect(probeQqLoginInfo(5550)).resolves.toBeNull();
    expect(execCommands()).toEqual(['ss -tlnp']);
  });

  it('returns null when both snapshots have more than one account', async () => {
    mockExec({ 'ss -tlnp': ssLine(4304, 5551) });
    httpGetMock.mockImplementation(replyBody(jsonp([
      { uin: '1' },
      { uin: '2' },
    ])));

    await expect(probeQqLoginInfo(5551)).resolves.toBeNull();
  });

  it('returns null when both fetches fail to parse a pt_get_uins body', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5552) });
    httpsGetMock.mockImplementation(replyBody('not-jsonp'));

    await expect(probeQqLoginInfo(5552)).resolves.toBeNull();
  });

  it('returns null when both fetches error', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5553) });
    httpsGetMock.mockImplementation(replyError(new Error('ECONNREFUSED')));

    await expect(probeQqLoginInfo(5553)).resolves.toBeNull();
  });

  it('destroys the request and returns null when both fetches time out', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5554) });
    const seen: RequestLike[] = [];
    httpsGetMock.mockImplementation(() => {
      const req = requestStub();
      seen.push(req);
      queueMicrotask(() => req.emit('timeout'));
      return req;
    });

    await expect(probeQqLoginInfo(5554)).resolves.toBeNull();
    expect(seen).toHaveLength(2);
    expect(seen[0]?.destroy).toHaveBeenCalledTimes(1);
    expect(seen[1]?.destroy).toHaveBeenCalledTimes(1);
  });

  it('joins chunked pt_get_uins bodies including Buffer pieces', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5560) });
    httpsGetMock.mockImplementation(replyBody([
      'ptui_getuins_CB([',
      Buffer.from('{"uin":"10001","nickname":"Ada"}'),
      ']);',
    ]));

    await expect(probeQqLoginInfo(5560)).resolves.toEqual({
      port: 4301,
      uin: '10001',
      nickName: 'Ada',
      identityKnown: true,
    });
  });

  it('treats a nickname that closes the JSONP array early as unusable', async () => {
    mockExec({ 'ss -tlnp': ssLine(4301, 5561) });
    httpsGetMock.mockImplementation(replyBody('ptui_getuins_CB([{"nickname":"a]b","uin":"1"}]);'));

    await expect(probeQqLoginInfo(5561)).resolves.toBeNull();
  });
});

describe('probeQqLoginInfo — win32 listing', () => {
  beforeEach(() => {
    setPlatform('win32');
  });

  it('returns null when netstat cannot list sockets', async () => {
    mockExec({ 'netstat -ano': new Error('netstat: access denied') });

    await expect(probeQqLoginInfo(6610)).resolves.toBeNull();
    expect(execCommands()).toEqual(['netstat -ano']);
    expect(execMock.mock.calls[0]?.[1]).toEqual(EXEC_OPTIONS);
  });

  it('counts QQ.exe rows from tasklist when netstat lists no sockets for the PID', async () => {
    mockExec({
      'netstat -ano': [
        'Active Connections',
        '',
        '  Proto  Local Address          Foreign Address        State           PID',
        netstatLine('127.0.0.1:4301', 1),
      ].join('\n'),
      'tasklist /fi "imagename eq QQ.exe" /nh': [
        'QQ.exe                     100 Console                    1     10,000 K',
        'QQ.exe                     101 Console                    1     11,000 K',
        'explorer.exe               200 Console                    1      9,000 K',
      ].join('\n'),
    });

    await expect(probeQqLoginInfo(6611)).resolves.toEqual({
      port: 0,
      uin: '',
      identityKnown: false,
    });
    expect(execCommands()).toEqual([
      'netstat -ano',
      'tasklist /fi "imagename eq QQ.exe" /nh',
    ]);
  });

  it('returns null when tasklist reports 6 or more QQ.exe rows and the PID has no sockets', async () => {
    mockExec({
      'netstat -ano': '',
      'tasklist /fi "imagename eq QQ.exe" /nh': [
        'QQ.exe 1',
        'QQ.exe 2',
        'QQ.exe 3',
        'qq.exe 4',
        'QQ.EXE 5',
        'QQ.exe 6',
      ].join('\n'),
    });

    await expect(probeQqLoginInfo(6612)).resolves.toBeNull();
  });

  it('does not treat a failed tasklist as logged out', async () => {
    mockExec({
      'netstat -ano': '',
      'tasklist /fi "imagename eq QQ.exe" /nh': new Error('tasklist: exit 1'),
    });

    await expect(probeQqLoginInfo(6613)).resolves.toBeNull();
  });

  it('parses netstat rows for the owning PID and skips short or portless lines', async () => {
    mockExec({
      'netstat -ano': [
        'Active Connections',
        '  TCP    127.0.0.1:4301    LISTENING',
        '  TCP    127.0.0.1    0.0.0.0:0    LISTENING    6620',
        netstatLine('10.0.0.8:18000', 1),
        netstatLine('127.0.0.1:4303', 6620),
        netstatLine('[::1]:4303', 6620),
        netstatLine('127.0.0.1:9218', 6620),
      ].join('\n'),
    });
    httpsGetMock.mockImplementation(replyBody(jsonp([{ uin: '20002', nickname: 'Win' }])));

    await expect(probeQqLoginInfo(6620)).resolves.toEqual({
      port: 4303,
      uin: '20002',
      nickName: 'Win',
      identityKnown: true,
    });
    expect(httpsGetMock).toHaveBeenCalledTimes(2);
    expect(httpsGetMock.mock.calls[0]?.[0]).toBe(
      'https://127.0.0.1:4303/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0',
    );
  });

  it('uses the first netstat port as a logged-out hint when no Ptlogin port is present', async () => {
    mockExec({
      'netstat -ano': [
        netstatLine('127.0.0.1:18000', 6630),
        netstatLine('127.0.0.1:18001', 6630),
      ].join('\n'),
      'tasklist /fi "imagename eq QQ.exe" /nh': 'QQ.exe 100\n',
    });

    await expect(probeQqLoginInfo(6630)).resolves.toEqual({
      port: 18000,
      uin: '',
      identityKnown: false,
    });
    expect(httpGetMock).not.toHaveBeenCalled();
    expect(httpsGetMock).not.toHaveBeenCalled();
  });
});

describe('probeQqLoginInfo — overall deadline', () => {
  it('returns null and warns after 5000ms if listing never finishes', async () => {
    vi.useFakeTimers();
    execMock.mockImplementation(() => undefined);
    const previousLevel = getLogLevel();
    setLogLevel('info');
    const warnings: string[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'LoginProbe' && entry.level === 'warn') {
        warnings.push(entry.message);
      }
    });

    try {
      const pending = probeQqLoginInfo(9001);
      let settled: unknown = 'pending';
      void pending.then((value) => {
        settled = value;
      });

      await vi.advanceTimersByTimeAsync(4999);
      expect(settled).toBe('pending');

      await vi.advanceTimersByTimeAsync(1);
      await expect(pending).resolves.toBeNull();
      expect(warnings).toEqual(['login check timed out: PID=9001']);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }
  });

  it('does not warn when the probe finishes before the deadline', async () => {
    mockExec({
      'ss -tlnp': '',
      'pgrep -c qq': '2\n',
    });
    const previousLevel = getLogLevel();
    setLogLevel('info');
    const warnings: string[] = [];
    const unsubscribe = subscribeLogs((entry) => {
      if (entry.scope === 'LoginProbe') warnings.push(entry.message);
    });

    try {
      await expect(probeQqLoginInfo(9002)).resolves.toEqual({
        port: 0,
        uin: '',
        identityKnown: false,
      });
      expect(warnings).toEqual([]);
    } finally {
      unsubscribe();
      setLogLevel(previousLevel);
    }
  });

  it('abandons a hung Ptlogin fetch at the overall deadline', async () => {
    vi.useFakeTimers();
    mockExec({ 'ss -tlnp': ssLine(4301, 9003) });
    httpsGetMock.mockImplementation(() => requestStub());

    const pending = probeQqLoginInfo(9003);
    await vi.advanceTimersByTimeAsync(5000);
    await expect(pending).resolves.toBeNull();
  });
});
