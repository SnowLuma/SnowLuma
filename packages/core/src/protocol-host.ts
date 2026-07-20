import { existsSync } from 'fs';
import path from 'path';
import { ProtocolHostClient, ProtocolSessionManager } from '@snowluma/bridge';
import { createLogger } from '@snowluma/common/logger';
import type { BridgeManager } from './bridge/manager';

const log = createLogger('ProtocolHost');

export function createProtocolSessionManager(bridgeManager: BridgeManager): ProtocolSessionManager {
  return new ProtocolSessionManager({
    bridgeManager,
    createHost: (id) => {
      const executable = resolveProtocolHostExecutable();
      const client = ProtocolHostClient.spawn({
        executable,
        dataDir: path.resolve(process.cwd(), 'data', 'protocol', id),
      });
      client.on('log', (event: { level?: string; message?: string }) => {
        const message = event.message ?? '';
        if (!message) return;
        if (event.level === 'error' || event.level === 'critical') log.error('%s', message);
        else if (event.level === 'warning') log.warn('%s', message);
        else log.info('%s', message);
      });
      return client;
    },
  });
}

export function resolveProtocolHostExecutable(
  platform = process.platform,
  arch = process.arch,
  cwd = process.cwd(),
): string {
  const explicit = process.env.SNOWLUMA_LAGRANGE_HOST?.trim();
  if (explicit) return path.resolve(explicit);

  const target = `${platform}-${arch}`;
  const extension = platform === 'win32' ? '.exe' : '';
  const filename = `snowluma-lagrange-host-${target}${extension}`;
  const candidates = [
    path.resolve(cwd, 'native', filename),
    path.resolve(cwd, 'dist', 'native', filename),
    path.resolve(cwd, 'packages', 'runtime', 'native', filename),
  ];
  return candidates.find(existsSync) ?? candidates[0]!;
}
