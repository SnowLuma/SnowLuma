import { describe, expect, it } from 'vitest';
import { resolveHookRuntimeDir } from '../src/hook-runtime-dir';

function procReader(files: Record<string, string>) {
  return (file: string): string => {
    const value = files[file];
    if (value === undefined) throw new Error(`missing fixture: ${file}`);
    return value;
  };
}

describe('resolveHookRuntimeDir — Linux target process ownership', () => {
  it('uses the QQ process runtime directory instead of the supervisor user directory', () => {
    expect(resolveHookRuntimeDir(46301, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/0' },
      ownUid: 0,
      readText: procReader({
        '/proc/46301/environ': 'HOME=/home/rikka\0XDG_RUNTIME_DIR=/run/user/1000\0',
        '/proc/46301/status': 'Name:\tqq\nUid:\t1000\t1000\t1000\t1000\n',
      }),
    })).toBe('/run/user/1000');
  });

  it('falls back to the QQ process uid when its environment has no runtime directory', () => {
    expect(resolveHookRuntimeDir(46301, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/0' },
      ownUid: 0,
      readText: procReader({
        '/proc/46301/environ': 'HOME=/home/rikka\0',
        '/proc/46301/status': 'Name:\tqq\nUid:\t1000\t1000\t1000\t1000\n',
      }),
    })).toBe('/tmp/snowluma-1000');
  });

  it('fails visibly when target ownership cannot be determined', () => {
    expect(() => resolveHookRuntimeDir(46301, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/0' },
      ownUid: 0,
      readText: () => { throw new Error('permission denied'); },
    })).toThrow(/cannot resolve hook runtime directory.*permission denied/);
  });

  it('uses the current convention when the target disappears during discovery', () => {
    const gone = Object.assign(new Error('process disappeared'), { code: 'ENOENT' });
    expect(resolveHookRuntimeDir(46301, {
      platform: 'linux',
      env: { XDG_RUNTIME_DIR: '/run/user/0' },
      ownUid: 0,
      readText: () => { throw gone; },
    })).toBe('/run/user/0');
  });

  it('honours an explicit runtime directory inherited by the QQ process', () => {
    expect(resolveHookRuntimeDir(46301, {
      platform: 'linux',
      env: {},
      ownUid: 0,
      readText: procReader({
        '/proc/46301/environ': 'SNOWLUMA_HOOK_RUNTIME_DIR=/srv/snowluma-hook\0',
        '/proc/46301/status': 'Uid:\t1000\t1000\t1000\t1000\n',
      }),
    })).toBe('/srv/snowluma-hook');
  });
});
