import net from 'net';
import { exec } from 'child_process';
import { promisify } from 'util';

const execAsync = promisify(exec);

const PORT_RANGE_START = 9210;
const PORT_RANGE_END = 9219;
const PROBE_TIMEOUT_MS = 1000;
const CONNECTION_TIMEOUT_MS = 500;

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
        const port = Number(portMatch[1]);
        if (port >= PORT_RANGE_START && port <= PORT_RANGE_END) {
          ports.add(port);
        }
      }
      return Array.from(ports);
    } else {
      const { stdout } = await execAsync(`ss -tlnp | grep pid=${pid}`);
      const ports = new Set<number>();
      const lines = stdout.split('\n');
      for (const line of lines) {
        const match = line.match(/:(\d+)\s/);
        if (match) {
          const port = Number(match[1]);
          if (port >= PORT_RANGE_START && port <= PORT_RANGE_END) {
            ports.add(port);
          }
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
    for (let port = PORT_RANGE_START; port <= PORT_RANGE_END; port++) {
      const info = await probePort(port);
      if (info) return info;
    }
    return null;
  }

  for (const port of ports) {
    const info = await probePort(port);
    if (info) return info;
  }

  return null;
}
