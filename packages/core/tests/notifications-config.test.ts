import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  DEFAULT_BODY_TEMPLATE,
  DEFAULT_DEBOUNCE_SECONDS,
  defaultNotificationsConfig,
  normalizeNotificationsConfig,
  renderTemplate,
} from '../src/notifications/config';

describe('renderTemplate — mechanical {key} substitution', () => {
  it('replaces present variables', () => {
    expect(
      renderTemplate('{nickname}({uin}) {event} @ {time}', {
        nickname: 'Bob',
        uin: '123',
        event: 'offline',
        time: '12:00',
      }),
    ).toBe('Bob(123) offline @ 12:00');
  });

  it('leaves missing placeholders untouched (原样)', () => {
    expect(renderTemplate('{a}-{b}', { a: 'x' })).toBe('x-{b}');
  });

  it('replaces repeated occurrences', () => {
    expect(renderTemplate('{x}{x}', { x: 'ab' })).toBe('abab');
  });

  it('leaves text with no placeholders unchanged', () => {
    expect(renderTemplate('hello', { x: '1' })).toBe('hello');
  });

  it('does no logic — an empty value substitutes as empty', () => {
    expect(renderTemplate('[{x}]', { x: '' })).toBe('[]');
  });

  it('is total — a non-string template yields an empty string', () => {
    expect(renderTemplate(undefined as unknown as string, {})).toBe('');
  });

  it('does NOT re-expand a substituted value that itself contains a placeholder', () => {
    // Load-bearing invariant: replacement text is never re-scanned. A refactor
    // to a recursive/loop replace would break this while passing every other test.
    expect(renderTemplate('{a}', { a: '{b}', b: 'NESTED' })).toBe('{b}');
  });

  it('escapes backslashes and quotes when template is JSON-like', () => {
    const tmpl = '{"text": "{val}"}';
    expect(renderTemplate(tmpl, { val: 'a"b\\c' })).toBe('{"text": "a\\"b\\\\c"}');
  });

  it('does NOT escape when template is plain text', () => {
    expect(renderTemplate('{val}', { val: 'a"b\\c' })).toBe('a"b\\c');
  });
});

describe('normalizeNotificationsConfig — total normalize', () => {
  it('collapses garbage / non-objects to the full default', () => {
    const d = defaultNotificationsConfig();
    for (const junk of [undefined, null, 42, 'nope', []]) {
      expect(normalizeNotificationsConfig(junk)).toEqual(d);
    }
  });

  it('forces version to 1 regardless of input', () => {
    expect(normalizeNotificationsConfig({ version: 99 }).version).toBe(1);
  });

  it('clamps + truncates debounceSeconds into [0, 3600]', () => {
    expect(normalizeNotificationsConfig({ debounceSeconds: -5 }).debounceSeconds).toBe(0);
    expect(normalizeNotificationsConfig({ debounceSeconds: 99999 }).debounceSeconds).toBe(3600);
    expect(normalizeNotificationsConfig({ debounceSeconds: 30.9 }).debounceSeconds).toBe(30);
    expect(normalizeNotificationsConfig({ debounceSeconds: '45' }).debounceSeconds).toBe(45);
    expect(normalizeNotificationsConfig({ debounceSeconds: 'x' }).debounceSeconds).toBe(DEFAULT_DEBOUNCE_SECONDS);
  });

  it('drops a non-array channels value', () => {
    expect(normalizeNotificationsConfig({ channels: 'nope' }).channels).toEqual([]);
  });

  it('keeps a valid channel and strips unknown fields', () => {
    const { channels } = normalizeNotificationsConfig({
      channels: [
        {
          id: 'dingtalk',
          name: 'DingTalk',
          url: 'https://oapi.dingtalk.com/robot/send',
          bodyTemplate: '{event}',
          enabled: true,
          evil: 'x',
          extra: 1,
        },
      ],
    });
    expect(channels).toEqual([
      {
        id: 'dingtalk',
        name: 'DingTalk',
        url: 'https://oapi.dingtalk.com/robot/send',
        bodyTemplate: '{event}',
        enabled: true,
      },
    ]);
  });

  it('drops channels lacking a valid id or http(s) url', () => {
    const { channels } = normalizeNotificationsConfig({
      channels: [
        { id: '', url: 'https://a.com' }, // empty id
        { id: 'bad id!', url: 'https://a.com' }, // invalid slug
        { id: 'noUrl' }, // missing url
        { id: 'ftp', url: 'ftp://a.com' }, // non-http scheme
        { id: 'ok', url: 'http://a.com' }, // valid
      ],
    });
    expect(channels.map((c) => c.id)).toEqual(['ok']);
  });

  it('dedupes channels by id (first occurrence wins)', () => {
    const { channels } = normalizeNotificationsConfig({
      channels: [
        { id: 'dup', url: 'https://a.com', name: 'first' },
        { id: 'dup', url: 'https://b.com', name: 'second' },
      ],
    });
    expect(channels).toHaveLength(1);
    expect(channels[0].name).toBe('first');
    expect(channels[0].url).toBe('https://a.com');
  });

  it('defaults enabled=true, name→id, and bodyTemplate→default', () => {
    const { channels } = normalizeNotificationsConfig({ channels: [{ id: 'c1', url: 'https://a.com' }] });
    expect(channels[0].enabled).toBe(true);
    expect(channels[0].name).toBe('c1');
    expect(channels[0].bodyTemplate).toBe(DEFAULT_BODY_TEMPLATE);
  });
});

describe('loadNotificationsConfig / saveNotificationsConfig (fs-backed)', () => {
  let tmp: string;
  let prevCwd: string;

  beforeEach(() => {
    prevCwd = process.cwd();
    tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'sl-notif-'));
    process.chdir(tmp);
    vi.resetModules();
  });

  afterEach(() => {
    process.chdir(prevCwd);
    fs.rmSync(tmp, { recursive: true, force: true });
  });

  it('creates a default config file when absent', async () => {
    const mod = await import('../src/notifications/config');
    const cfg = mod.loadNotificationsConfig();
    expect(cfg).toEqual(mod.defaultNotificationsConfig());
    expect(fs.existsSync(path.join('config', 'notifications.json'))).toBe(true);
  });

  it('round-trips a saved config across a fresh module load', async () => {
    const mod = await import('../src/notifications/config');
    const saved = mod.saveNotificationsConfig({
      debounceSeconds: 60,
      channels: [{ id: 'c1', name: 'C1', url: 'https://a.com/hook', bodyTemplate: '{event}', enabled: false }],
    });
    expect(saved.debounceSeconds).toBe(60);
    expect(saved.channels).toHaveLength(1);

    vi.resetModules();
    const mod2 = await import('../src/notifications/config');
    expect(mod2.loadNotificationsConfig()).toEqual(saved);
  });

  it('section-merges partial saves (debounce-only keeps channels)', async () => {
    const mod = await import('../src/notifications/config');
    mod.saveNotificationsConfig({ channels: [{ id: 'c1', url: 'https://a.com' }] });
    const after = mod.saveNotificationsConfig({ debounceSeconds: 120 });
    expect(after.debounceSeconds).toBe(120);
    expect(after.channels.map((c) => c.id)).toEqual(['c1']);
  });

  it('self-heals an unreadable file on load', async () => {
    fs.mkdirSync('config', { recursive: true });
    fs.writeFileSync(path.join('config', 'notifications.json'), '{ not valid json', 'utf8');
    const mod = await import('../src/notifications/config');
    expect(mod.loadNotificationsConfig()).toEqual(mod.defaultNotificationsConfig());
  });
});
