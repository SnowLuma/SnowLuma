import net from 'net';

function isPortAvailable(port: number, host = '127.0.0.1'): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    let settled = false;
    const finalize = (ok: boolean) => {
      if (settled) return;
      settled = true;
      try {
        server.close(() => resolve(ok));
      } catch {
        resolve(ok);
      }
    };
    server.once('error', () => finalize(false));
    server.once('listening', () => finalize(true));
    try {
      server.listen(port, host);
    } catch {
      finalize(false);
    }
  });
}

/**
 * Find an available TCP port starting from `start`, advancing by 1 up to `maxTries` attempts.
 * Skips reserved/invalid port numbers.
 */
export async function findAvailablePort(
  start: number,
  options: { maxTries?: number; host?: string } = {},
): Promise<number> {
  const { maxTries = 50, host = '127.0.0.1' } = options;
  let port = Math.max(1, Math.min(65535, Math.trunc(start)));
  for (let i = 0; i < maxTries; i++) {
    if (port > 65535) break;
    if (await isPortAvailable(port, host)) return port;
    port += 1;
  }
  throw new Error(`No available TCP port found near ${start}`);
}
