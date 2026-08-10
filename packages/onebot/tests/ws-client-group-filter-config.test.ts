import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  assertValidOneBotConfig,
  loadOneBotConfig,
  makeDefaultOneBotConfig,
  prepareOneBotConfigForRestore,
  saveOneBotConfig,
} from '../src/config';

describe('ws client group message filter config', () => {
  let tempDir: string;
  let previousCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-onebot-group-filter-'));
    previousCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(previousCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('round-trips a ws client group message filter', () => {
    const config = makeDefaultOneBotConfig();
    config.networks.wsClients.push({
      name: 'airi',
      url: 'wss://example.com/onebot/v11/ws',
      role: 'Universal',
      reconnectIntervalMs: 5000,
      messageFormat: 'array',
      reportSelfMessage: false,
      groupMessageFilter: {
        mode: 'blacklist',
        groupIds: [985983966, 787682322, 985983966],
      },
    });

    saveOneBotConfig('10001', config);
    const reloaded = loadOneBotConfig('10001');

    expect(reloaded.networks.wsClients[0].groupMessageFilter).toEqual({
      mode: 'blacklist',
      groupIds: [985983966, 787682322],
    });
  });

  it('rejects malformed ws client group message filters', () => {
    const invalidValues: unknown[] = [
      null,
      { mode: 'deny', groupIds: [985983966] },
      { mode: 'blacklist', groupIds: '985983966' },
      { mode: 'blacklist', groupIds: [0] },
      { mode: 'blacklist', groupIds: [-1] },
      { mode: 'blacklist', groupIds: [1.5] },
      { mode: 'blacklist', groupIds: [Number.MAX_SAFE_INTEGER + 1] },
    ];

    for (const groupMessageFilter of invalidValues) {
      const config = makeDefaultOneBotConfig();
      config.networks.wsClients.push({
        name: 'bad-filter',
        url: 'ws://127.0.0.1:8080/ws',
        messageFormat: 'array',
        reportSelfMessage: false,
        groupMessageFilter,
      } as never);

      expect(() => assertValidOneBotConfig(config)).toThrow(/groupMessageFilter/);
    }
  });

  it('accepts a valid filter and rejects malformed filter content during restore', () => {
    const valid = {
      mode: 'snapshot',
      networks: {
        httpServers: [],
        httpClients: [],
        wsServers: [],
        wsClients: [{
          name: 'airi',
          url: 'wss://example.com/ws',
          messageFormat: 'array',
          reportSelfMessage: false,
          groupMessageFilter: { mode: 'whitelist', groupIds: [123, 456] },
        }],
      },
      statusCommand: { enabled: true, swallow: false, cooldownSeconds: 5, trigger: '#sl' },
      historySync: { enabled: false },
      notifications: { channelIds: [] },
    };

    expect(() => prepareOneBotConfigForRestore(valid, 'per-uin')).not.toThrow();

    const invalid = structuredClone(valid);
    invalid.networks.wsClients[0].groupMessageFilter = {
      mode: 'whitelist',
      groupIds: ['123'],
    } as never;

    expect(() => prepareOneBotConfigForRestore(invalid, 'per-uin'))
      .toThrow(/groupMessageFilter/);
  });
});
