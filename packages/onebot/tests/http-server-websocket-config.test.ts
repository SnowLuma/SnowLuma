import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  assertValidOneBotConfig,
  loadOneBotConfig,
  makeDefaultOneBotConfig,
  prepareOneBotConfigForRestore,
  saveOneBotConfig,
} from '../src/config';

describe('HTTP server WebSocket configuration', () => {
  let previousCwd: string;
  let tempDir: string;

  beforeEach(() => {
    previousCwd = process.cwd();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-http-ws-config-'));
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('persists the opt-in switch through save and load', () => {
    const config = makeDefaultOneBotConfig();
    expect(config.networks.httpServers[0].enableWebSocket).toBe(false);
    config.networks.httpServers[0].enableWebSocket = true;

    saveOneBotConfig('10001', config);

    const onDisk = JSON.parse(
      fs.readFileSync(path.join(tempDir, 'config', 'onebot_10001.json'), 'utf8'),
    ) as { networks: { httpServers: Array<{ enableWebSocket?: boolean }> } };
    expect(onDisk.networks.httpServers[0].enableWebSocket).toBe(true);
    expect(loadOneBotConfig('10001').networks.httpServers[0].enableWebSocket).toBe(true);
  });

  it('rejects non-boolean values at public save and restore boundaries', () => {
    const config = makeDefaultOneBotConfig();
    (config.networks.httpServers[0] as unknown as Record<string, unknown>).enableWebSocket = 'yes';
    expect(() => assertValidOneBotConfig(config)).toThrow(/enableWebSocket must be a boolean/);

    expect(() => prepareOneBotConfigForRestore({
      networks: {
        httpServers: [{
          name: 'http',
          host: '127.0.0.1',
          port: 3000,
          path: '/',
          enableWebSocket: 'yes',
        }],
      },
    }, 'per-uin')).toThrow(/enableWebSocket must be a boolean/);
  });

  it('fails fast when a hand-written config contains a non-boolean switch', () => {
    fs.mkdirSync(path.join(tempDir, 'config'), { recursive: true });
    fs.writeFileSync(path.join(tempDir, 'config', 'onebot_10002.json'), JSON.stringify({
      mode: 'snapshot',
      networks: {
        httpServers: [{
          name: 'http',
          host: '127.0.0.1',
          port: 3000,
          path: '/',
          enableWebSocket: 'yes',
        }],
        httpClients: [],
        wsServers: [],
        wsClients: [],
      },
    }), 'utf8');

    expect(() => loadOneBotConfig('10002')).toThrow(/enableWebSocket must be a boolean/);
  });
});
