import { createLogger } from '@snowluma/common/logger';
import { exec } from 'child_process';
import net from 'net';
import http from 'http';
import https from 'https';
import { promisify } from 'util';

const execAsync = promisify(exec);
const log = createLogger('LoginProbe');

const PORT_RANGE_START = 9210;
const PORT_RANGE_END = 9219;
const PROBE_TIMEOUT_MS = 1000;
const CONNECTION_TIMEOUT_MS = 500;
const COMMAND_TIMEOUT_MS = 1500;
const OVERALL_PROBE_TIMEOUT_MS = 5000;
const EXEC_OPTIONS = { timeout: COMMAND_TIMEOUT_MS, killSignal: 'SIGKILL' as const };
// QQ's Ptlogin quick-login ports plus its main process mean a single
// logged-in client surfaces roughly this many processes. When no usable
// probe port is found, a count BELOW this implies the target PID is still at
// the login screen; AT/ABOVE it the environment is ambiguous (multiple or
// unrelated `qq` processes), so we fall through to deep-link probing rather
// than guess "logged out".
const LOGGED_OUT_PROCESS_COUNT_MAX = 6;

export interface QqPortLoginInfo {
  port: number;
  uin: string;
  uid?: string;
  nickName?: string;
  loggedIn: boolean;
}

interface JwtPayload {
  errCode: number;
  errMsg: string;
  port: number;
  uin?: string;
  uid?: string;
  nickName?: string;
  data?: {
    uin?: string;
    url?: string;
  };
  iat: number;
}

function decodeJwt(token: string): JwtPayload | null {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;
    const payload = Buffer.from(parts[1], 'base64').toString('utf8');
    return JSON.parse(payload);
  } catch {
    return null;
  }
}


async function probePort(port: number): Promise<QqPortLoginInfo | null> {
  return new Promise((resolve) => {
    const client = new net.Socket();
    const link = 'tencent://';
    const payload = `POST /tencent HTTP/1.1\r\nHost: 127.0.0.1:${port}\r\nConnection: close\r\nContent-Length: ${link.length}\r\n\r\n${link}`;

    let responseData = '';
    let timer: NodeJS.Timeout;

    const cleanup = () => {
      clearTimeout(timer);
      client.removeAllListeners();
      client.destroy();
    };

    timer = setTimeout(() => {
      cleanup();
      resolve(null);
    }, PROBE_TIMEOUT_MS);

    client.setTimeout(CONNECTION_TIMEOUT_MS);

    client.connect(port, '127.0.0.1', () => {
      client.write(payload);
    });

    client.on('data', (data) => {
      responseData += data.toString();
    });

    client.on('close', () => {
      cleanup();
      const jwtMatch = responseData.match(/eyJ[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/);
      if (!jwtMatch) {
        resolve(null);
        return;
      }

      const decoded = decodeJwt(jwtMatch[0]);
      if (!decoded || decoded.errCode !== 0) {
        resolve(null);
        return;
      }

      const uin = decoded.uin || decoded.data?.uin || '';
      resolve({
        port,
        uin,
        uid: decoded.uid,
        nickName: decoded.nickName,
        loggedIn: uin.length > 0,
      });
    });

    client.on('error', () => {
      cleanup();
      resolve(null);
    });

    client.on('timeout', () => {
      cleanup();
      resolve(null);
    });
  });
}


/** One entry of the Ptlogin `pt_get_uins` JSONP array. Only the fields the
 *  probe reads are modelled; QQ sends more but they're irrelevant here. */
interface PtloginUin {
  uin?: string | number;
  account?: string | number;
  nickname?: string;
}

/**
 * One `pt_get_uins` call. Returns the parsed account array (possibly empty —
 * an EMPTY array is a real answer: "0 accounts", NOT an error) or `null` when
 * the port could not be reached / the body was not a usable pt_get_uins
 * response (connect refused, timeout, unparseable). Callers MUST distinguish
 * the two: `[]` feeds the logged-in/out decision, `null` means "network
 * problem, no answer" and should fall through to the deep-link fallback.
 */
async function fetchPtlogin(port: number, useHttps: boolean): Promise<PtloginUin[] | null> {
  return new Promise((resolve) => {
    const protocol = useHttps ? 'https' : 'http';
    const url = `${protocol}://127.0.0.1:${port}/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0`;

    const headers = {
      Host: 'localhost.ptlogin2.qq.com',
      Referer: 'https://xui.ptlogin2.qq.com/',
      Cookie: 'pt_local_token=0',
    };

    const handleResponse = (res: http.IncomingMessage) => {
      let text = '';
      res.on('data', (chunk) => { text += chunk.toString(); });
      res.on('end', () => {
        try {
          const inner = text.split('[')[1].split(']')[0];
          const data = JSON.parse('[' + inner + ']') as PtloginUin[];
          resolve(data);
        } catch {
          resolve(null);
        }
      });
    };

    const req = useHttps
      ? https.get(url, { headers, timeout: CONNECTION_TIMEOUT_MS, rejectUnauthorized: false }, handleResponse)
      : http.get(url, { headers, timeout: CONNECTION_TIMEOUT_MS }, handleResponse);

    req.on('error', () => resolve(null));
    req.on('timeout', () => {
      req.destroy();
      resolve(null);
    });
  });
}

async function tryPtloginMethod(port: number): Promise<QqPortLoginInfo | 'fallback'> {
  const useHttps = port % 2 !== 0;

  const res1 = await fetchPtlogin(port, useHttps);
  const res2 = await fetchPtlogin(port, useHttps);

  if (res1 === null && res2 === null) return 'fallback';

  const usable = [res1, res2].filter((r): r is PtloginUin[] => r !== null);
  const target = usable.reduce((a, b) => (a.length <= b.length ? a : b));

  if (target.length === 1) {
    const account = target[0];
    return {
      port,
      uin: String(account.uin || account.account || ''),
      nickName: account.nickname || '',
      loggedIn: true,
    };
  }

  return 'fallback';
}


async function getQqProcessCount(): Promise<number> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(
        'tasklist /fi "imagename eq QQ.exe" /nh',
        EXEC_OPTIONS,
      );
      return stdout.toLowerCase().split('\n').filter(line => line.includes('qq.exe')).length;
    } else {
      const { stdout } = await execAsync('pgrep -c qq', EXEC_OPTIONS);
      return parseInt(stdout.trim(), 10) || 0;
    }
  } catch {
    // On failure report the ambiguous threshold so we never falsely
    // conclude "logged out".
    return LOGGED_OUT_PROCESS_COUNT_MAX;
  }
}

async function getProcessPorts(pid: number): Promise<number[] | null> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('netstat -ano', EXEC_OPTIONS);
      const ports = new Set<number>();
      const lines = stdout.split('\n');
      for (const line of lines) {
        const parts = line.trim().split(/\s+/);
        if (parts.length < 5) continue;
        const owningPid = parts[parts.length - 1];
        if (owningPid !== String(pid)) continue;

        const localAddr = parts[1];
        const portMatch = localAddr.match(/:(\d+)$/);
        if (!portMatch) continue;
        ports.add(Number(portMatch[1]));
      }
      return Array.from(ports);
    } else {
      const { stdout } = await execAsync('ss -tlnp', EXEC_OPTIONS);
      const ports = new Set<number>();
      const lines = stdout.split('\n');
      for (const line of lines) {
        if (!line.includes(`pid=${pid},`) && !line.includes(`pid=${pid})`)) continue;
        const match = line.match(/:(\d+)\s/);
        if (match) {
          ports.add(Number(match[1]));
        }
      }
      return Array.from(ports);
    }
  } catch {
    return null;
  }
}

async function probeQqLoginInfoInternal(pid: number): Promise<QqPortLoginInfo | null> {
  const ports = await getProcessPorts(pid);
  if (ports === null) return null;

  if (ports.length === 0) {
    const totalPids = await getQqProcessCount();
    if (totalPids < LOGGED_OUT_PROCESS_COUNT_MAX) {
      return { port: 0, uin: '', loggedIn: false };
    }
    return null;
  }
  const ODD_PT_PORTS = [4301, 4303, 4305, 4307, 4309];
  const EVEN_PT_PORTS = [4302, 4304, 4306, 4308, 4310];

  const matchedOddPorts = ports.filter(p => ODD_PT_PORTS.includes(p));
  const matchedEvenPorts = ports.filter(p => EVEN_PT_PORTS.includes(p));

  let ptPortsToTry: number[] = [];
  if (matchedOddPorts.length > 0) {
    ptPortsToTry = matchedOddPorts;
  } else if (matchedEvenPorts.length > 0) {
    ptPortsToTry = matchedEvenPorts;
  }

  if (ptPortsToTry.length > 0) {
    for (const port of ptPortsToTry) {
      const ptResult = await tryPtloginMethod(port);
      if (ptResult !== 'fallback') {
        return ptResult;
      }
    }
  } else {
    const totalPids = await getQqProcessCount();
    if (totalPids < LOGGED_OUT_PROCESS_COUNT_MAX) {
      return {
        port: ports[0] || 0,
        uin: '',
        loggedIn: false,
      };
    }
  }

  const deepLinkPorts = ports.filter(p => p >= PORT_RANGE_START && p <= PORT_RANGE_END);
  for (const port of deepLinkPorts) {
    const info = await probePort(port);
    if (info) return info;
  }

  return null;
}

export async function probeQqLoginInfo(pid: number): Promise<QqPortLoginInfo | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  const timeout = new Promise<null>(resolve => {
    timer = setTimeout(() => {
      timedOut = true;
      resolve(null);
    }, OVERALL_PROBE_TIMEOUT_MS);
  });
  try {
    const result = await Promise.race([probeQqLoginInfoInternal(pid), timeout]);
    if (timedOut) log.warn('login check timed out: PID=%d', pid);
    return result;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
