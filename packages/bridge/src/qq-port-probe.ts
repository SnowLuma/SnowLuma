import { exec } from 'child_process';
import net from 'net';
import https from 'https';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PORT_RANGE_START = 9210;
const PORT_RANGE_END = 9219;
const PROBE_TIMEOUT_MS = 1000;
const CONNECTION_TIMEOUT_MS = 500;
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

async function fetchPtlogin(port: number): Promise<PtloginUin[]> {
  return new Promise((resolve) => {
    const url = `https://127.0.0.1:${port}/pt_get_uins?callback=ptui_getuins_CB&pt_local_tk=0`;

    const req = https.get(
      url,
      {
        headers: {
          Host: 'localhost.ptlogin2.qq.com',
          Referer: 'https://xui.ptlogin2.qq.com/',
          Cookie: 'pt_local_token=0',
        },
        rejectUnauthorized: false, // 忽略本地自签证书报错
        timeout: CONNECTION_TIMEOUT_MS,
      },
      (res) => {
        let text = '';
        res.on('data', (chunk) => { text += chunk.toString(); });
        res.on('end', () => {
          try {
            // 100% 复刻 Python 切片逻辑：获取两个方括号中间的字符串，再包装成数组
            const inner = text.split('[')[1].split(']')[0];
            const data = JSON.parse('[' + inner + ']') as PtloginUin[];
            resolve(data);
          } catch {
            resolve([]);
          }
        });
      }
    );

    req.on('error', () => resolve([]));
    req.on('timeout', () => {
      req.destroy();
      resolve([]);
    });
  });
}

async function tryPtloginMethod(port: number): Promise<QqPortLoginInfo | 'fallback'> {
  // 抽象的 QQNT
  const res1 = await fetchPtlogin(port);
  const res2 = await fetchPtlogin(port);

  const target = res1.length < res2.length ? res1 : res2;

  if (target.length === 1) {
    const account = target[0];
    return {
      port,
      uin: String(account.uin || account.account || ''),
      nickName: account.nickname || '',
      loggedIn: true,
    };
  }

  // Any non-1 result — the 2+0 alternation, both-2, both-empty, etc. — is
  // inconclusive; hand off to the deep-link / process-count fallback.
  return 'fallback';
}


async function getQqProcessCount(): Promise<number> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync('tasklist /fi "imagename eq QQ.exe" /nh');
      return stdout.toLowerCase().split('\n').filter(line => line.includes('qq.exe')).length;
    } else {
      const { stdout } = await execAsync('pgrep -c qq');
      return parseInt(stdout.trim(), 10) || 0;
    }
  } catch {
    // On failure report the ambiguous threshold so we never falsely
    // conclude "logged out".
    return LOGGED_OUT_PROCESS_COUNT_MAX;
  }
}

async function getProcessPorts(pid: number): Promise<number[]> {
  try {
    if (process.platform === 'win32') {
      const { stdout } = await execAsync(`netstat -ano | findstr ${pid}`);
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
      const { stdout } = await execAsync(`ss -tlnp | grep pid=${pid}`);
      const ports = new Set<number>();
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/:(\d+)\s/);
        if (match) {
          ports.add(Number(match[1]));
        }
      }
      return Array.from(ports);
    }
  } catch {
    return [];
  }
}


export async function probeQqLoginInfo(pid: number): Promise<QqPortLoginInfo | null> {
  const ports = await getProcessPorts(pid);

  if (ports.length === 0) {
    const totalPids = await getQqProcessCount();
    if (totalPids < LOGGED_OUT_PROCESS_COUNT_MAX) {
      return { port: 0, uin: '', loggedIn: false };
    }
    return null;
  }

  const PT_PORTS = [4301, 4303, 4305, 4307, 4309];
  const matchedPtPorts = ports.filter(p => PT_PORTS.includes(p));

  if (matchedPtPorts.length > 0) {
    for (const port of matchedPtPorts) {
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
