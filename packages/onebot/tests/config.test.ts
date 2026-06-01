import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { loadOneBotConfig, makeDefaultOneBotConfig, saveOneBotConfig } from '../src/config';

const TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

describe('makeDefaultOneBotConfig', () => {
  it('returns default unified networks structure', () => {
    const config = makeDefaultOneBotConfig();
    expect(config.networks.httpServers).toHaveLength(1);
    expect(config.networks.httpServers[0].name).toBe('http-default');
    expect(config.networks.httpServers[0].host).toBe('0.0.0.0');
    expect(config.networks.httpServers[0].port).toBe(3000);
    expect(config.networks.httpServers[0].accessToken).toMatch(TOKEN_PATTERN);
    expect(config.networks.httpServers[0].messageFormat).toBe('array');
    expect(config.networks.httpServers[0].reportSelfMessage).toBe(false);
    expect(config.networks.httpClients).toEqual([]);
    expect(config.networks.wsServers).toHaveLength(1);
    expect(config.networks.wsServers[0].port).toBe(3001);
    expect(config.networks.wsServers[0].role).toBe('Universal');
    expect(config.networks.wsServers[0].accessToken).toMatch(TOKEN_PATTERN);
    expect(config.networks.wsServers[0].messageFormat).toBe('array');
    expect(config.networks.wsServers[0].reportSelfMessage).toBe(false);
    expect(config.networks.wsClients).toEqual([]);
    expect(config.musicSignUrl).toBe('');
    expect(config.statusCommand).toEqual({ enabled: true, swallow: false, cooldownSeconds: 5 });
  });
});

describe('loadOneBotConfig', () => {
  let tempDir: string;
  let prevCwd: string;

  beforeEach(() => {
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-onebot-config-'));
    prevCwd = process.cwd();
    process.chdir(tempDir);
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('creates and persists default config when none exists', () => {
    const uin = '10001';
    const config = loadOneBotConfig(uin, { persistDefaults: true });
    expect(config.networks.httpServers).toHaveLength(1);

    const onDisk = JSON.parse(fs.readFileSync(path.join(tempDir, 'config', `onebot_${uin}.json`), 'utf8'));
    expect(onDisk.networks).toBeDefined();
    expect(Array.isArray(onDisk.networks.httpServers)).toBe(true);
    expect(onDisk.networks.httpServers[0].name).toBe('http-default');
    expect(onDisk.networks.httpServers[0].accessToken).toMatch(TOKEN_PATTERN);
    expect(onDisk.networks.wsServers[0].accessToken).toMatch(TOKEN_PATTERN);
    // Legacy keys must not appear in the persisted file.
    expect(onDisk.httpServers).toBeUndefined();
    expect(onDisk.wsServers).toBeUndefined();
    // statusCommand is materialised with defaults on a fresh install.
    expect(onDisk.statusCommand).toEqual({ enabled: true, swallow: false, cooldownSeconds: 5 });
  });

  it('fills statusCommand defaults and clamps a negative cooldown', () => {
    const uin = '10042';
    const dir = path.join(tempDir, 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, `onebot_${uin}.json`),
      JSON.stringify({
        networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
        statusCommand: { swallow: true, cooldownSeconds: -3 },
      }),
    );

    const config = loadOneBotConfig(uin);
    expect(config.statusCommand.enabled).toBe(true); // default filled (absent in file)
    expect(config.statusCommand.swallow).toBe(true); // taken from file
    expect(config.statusCommand.cooldownSeconds).toBe(0); // negative clamped to 0
  });

  it('migrates legacy per-type arrays into networks groups', () => {
    const uin = '10002';
    const dir = path.join(tempDir, 'config');
    fs.mkdirSync(dir, { recursive: true });
    const legacy = {
      httpServers: [{ host: '0.0.0.0', port: 3100, path: '/', accessToken: 'tok' }],
      httpPostEndpoints: [{ name: 'main-bot', url: 'http://127.0.0.1:5700' }],
      wsServers: [{ host: '0.0.0.0', port: 3101 }],
      wsClients: [{ url: 'ws://127.0.0.1:8080' }],
      musicSignUrl: 'https://example.com/sign',
      messageFormat: 'string',
      reportSelfMessage: true,
    };
    fs.writeFileSync(path.join(dir, `onebot_${uin}.json`), JSON.stringify(legacy), 'utf8');

    const config = loadOneBotConfig(uin, { persistDefaults: true });
    expect(config.networks.httpServers).toHaveLength(1);
    expect(config.networks.httpServers[0].port).toBe(3100);
    expect(config.networks.httpServers[0].accessToken).toBe('tok');
    expect(config.networks.httpServers[0].messageFormat).toBe('string');
    expect(config.networks.httpServers[0].reportSelfMessage).toBe(true);

    expect(config.networks.httpClients).toHaveLength(1);
    expect(config.networks.httpClients[0].name).toBe('main-bot');
    expect(config.networks.httpClients[0].url).toBe('http://127.0.0.1:5700');
    expect(config.networks.httpClients[0].messageFormat).toBe('string');
    expect(config.networks.httpClients[0].reportSelfMessage).toBe(true);

    expect(config.networks.wsServers).toHaveLength(1);
    expect(config.networks.wsServers[0].port).toBe(3101);
    expect(config.networks.wsServers[0].messageFormat).toBe('string');
    expect(config.networks.wsServers[0].reportSelfMessage).toBe(true);

    expect(config.networks.wsClients).toHaveLength(1);
    expect(config.networks.wsClients[0].url).toBe('ws://127.0.0.1:8080');
    expect(config.networks.wsClients[0].messageFormat).toBe('string');
    expect(config.networks.wsClients[0].reportSelfMessage).toBe(true);

    expect(config.musicSignUrl).toBe('https://example.com/sign');

    // File should now be in unified format on disk.
    const onDisk = JSON.parse(fs.readFileSync(path.join(dir, `onebot_${uin}.json`), 'utf8'));
    expect(onDisk.networks).toBeDefined();
    expect(onDisk.httpServers).toBeUndefined();
    expect(onDisk.httpPostEndpoints).toBeUndefined();
    expect(onDisk.messageFormat).toBeUndefined();
    expect(onDisk.reportSelfMessage).toBeUndefined();
    expect(onDisk.networks.httpServers[0].messageFormat).toBe('string');
    expect(onDisk.networks.httpServers[0].reportSelfMessage).toBe(true);
  });

  it('round-trips per-adapter overrides through save/load', () => {
    const uin = '10003';
    const config = makeDefaultOneBotConfig();
    config.networks.httpClients.push({
      name: 'self-mirror',
      url: 'http://127.0.0.1:9000',
      messageFormat: 'string',
      reportSelfMessage: true,
    });
    saveOneBotConfig(uin, config);

    const reloaded = loadOneBotConfig(uin);
    expect(reloaded.networks.httpClients).toHaveLength(1);
    expect(reloaded.networks.httpClients[0].name).toBe('self-mirror');
    expect(reloaded.networks.httpClients[0].messageFormat).toBe('string');
    expect(reloaded.networks.httpClients[0].reportSelfMessage).toBe(true);
  });

  it('does not write to disk by default (read-only contract)', () => {
    const uin = '10006';
    const cfgPath = path.join(tempDir, 'config', `onebot_${uin}.json`);

    // Default call must not materialize the file or mint a fresh access token.
    const config = loadOneBotConfig(uin);
    expect(config.networks.httpServers).toHaveLength(1);
    expect(fs.existsSync(cfgPath)).toBe(false);

    // Explicit opt-in still writes.
    loadOneBotConfig(uin, { persistDefaults: true });
    expect(fs.existsSync(cfgPath)).toBe(true);
  });

  it('respects an operator-emptied adapter list instead of seeding defaults back', () => {
    const uin = '10007';
    const dir = path.join(tempDir, 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `onebot_${uin}.json`), JSON.stringify({
      networks: { httpServers: [], httpClients: [], wsServers: [], wsClients: [] },
      musicSignUrl: '',
    }), 'utf8');

    const config = loadOneBotConfig(uin, { persistDefaults: true });
    expect(config.networks.httpServers).toEqual([]);
    expect(config.networks.wsServers).toEqual([]);
  });

  it('migrates legacy lowercase WsRole values into canonical uppercase form', () => {
    const uin = '10005';
    const dir = path.join(tempDir, 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `onebot_${uin}.json`), JSON.stringify({
      networks: {
        httpServers: [],
        httpClients: [],
        wsServers: [
          { name: 'ws-legacy', host: '0.0.0.0', port: 3201, path: '/', role: 'universal', messageFormat: 'array', reportSelfMessage: false },
        ],
        wsClients: [
          { name: 'wsc-legacy', url: 'ws://127.0.0.1:8080', role: 'event', messageFormat: 'array', reportSelfMessage: false },
        ],
      },
    }), 'utf8');

    const config = loadOneBotConfig(uin);
    expect(config.networks.wsServers).toHaveLength(1);
    expect(config.networks.wsServers[0].role).toBe('Universal');
    expect(config.networks.wsClients).toHaveLength(1);
    expect(config.networks.wsClients[0].role).toBe('Event');
  });

  it('auto-generates names for legacy entries that lack one', () => {
    const uin = '10004';
    const dir = path.join(tempDir, 'config');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, `onebot_${uin}.json`), JSON.stringify({
      httpServers: [
        { port: 3000 },
        { port: 3001 },
      ],
    }), 'utf8');

    const config = loadOneBotConfig(uin);
    const names = config.networks.httpServers.map((n) => n.name);
    expect(names).toHaveLength(2);
    expect(new Set(names).size).toBe(2); // unique
    expect(names.every((n) => n.length > 0)).toBe(true);
    expect(config.networks.httpServers.every((n) => n.messageFormat === 'array')).toBe(true);
    expect(config.networks.httpServers.every((n) => n.reportSelfMessage === false)).toBe(true);
  });
});

