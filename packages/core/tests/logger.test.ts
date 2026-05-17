// Tests for the core logger API:
//   - createLogger() output shape (scope rendering)
//   - .child({ uin }) derivation and the [UIN] slot in the rendered line
//   - LogEntry.uin propagation to subscribers
//   - File transport per-UIN fan-out (and the SNOWLUMA_LOG_PER_UIN=0 gate)
//
// We exercise the file transport via its real fs paths against tmpdirs
// so the test catches integration regressions, not just unit shape.

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createLogger, subscribeLogs, type LogEntry } from '../src/utils/logger';
import { _resetFileTransportForTesting } from '../src/utils/log-file-transport';

let tmpDir: string;
const ENV_KEYS = [
  'SNOWLUMA_LOG_FILE',
  'SNOWLUMA_LOG_PER_UIN',
  'SNOWLUMA_LOG_DIR',
  'SNOWLUMA_LOG_MAX_MB',
  'SNOWLUMA_LOG_RETAIN_DAYS',
  'SNOWLUMA_LOG_LEVEL',
  'NO_COLOR',
] as const;
const savedEnv: Record<string, string | undefined> = {};

function setEnv(env: Partial<Record<(typeof ENV_KEYS)[number], string | undefined>>): void {
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
}

beforeEach(async () => {
  for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-logger-'));
  setEnv({
    SNOWLUMA_LOG_DIR: tmpDir,
    SNOWLUMA_LOG_FILE: '1',
    SNOWLUMA_LOG_PER_UIN: '1',
    SNOWLUMA_LOG_MAX_MB: '5',
    SNOWLUMA_LOG_RETAIN_DAYS: '7',
    NO_COLOR: '1',
  });
  await _resetFileTransportForTesting();
});

afterEach(async () => {
  await _resetFileTransportForTesting();
  for (const k of ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('createLogger', () => {
  it('renders [Scope] with the empty UIN slot when no child binding', async () => {
    const log = createLogger('Bridge');
    const captured: LogEntry[] = [];
    const unsub = subscribeLogs((e) => captured.push(e));
    log.info('hello');
    unsub();

    expect(captured).toHaveLength(1);
    const entry = captured[0]!;
    expect(entry.scope).toBe('Bridge');
    expect(entry.uin).toBeUndefined();
    // Plain-text line shape (NO_COLOR=1):
    //   HH:MM:SS · INFO_ · _<12 blank uin slot>_ · [Bridge] · msg
    // where · = single separator space inside the template literal.
    const tail = entry.line.slice(9); // drop "HH:MM:SS "
    expect(tail).toBe(`INFO  ${' '.repeat(12)} [Bridge] hello`);
  });

  it('child({ uin }) derives a logger that stamps the [UIN] slot', async () => {
    const log = createLogger('Bridge').child({ uin: 12345 });
    const captured: LogEntry[] = [];
    const unsub = subscribeLogs((e) => captured.push(e));
    log.info('via child');
    unsub();

    expect(captured).toHaveLength(1);
    const entry = captured[0]!;
    expect(entry.uin).toBe(12345);
    expect(entry.scope).toBe('Bridge');
    // "[12345]" is 7 chars; padEnd to 12 leaves 5 trailing spaces inside
    // the slot, then 1 separator space before "[Bridge]".
    const tail = entry.line.slice(9);
    expect(tail).toBe(`INFO  [12345]      [Bridge] via child`);
  });

  it('child() does not mutate the parent logger', async () => {
    const parent = createLogger('Bridge');
    const childA = parent.child({ uin: 100 });
    const childB = parent.child({ uin: 200 });

    const captured: LogEntry[] = [];
    const unsub = subscribeLogs((e) => captured.push(e));
    parent.info('parent');
    childA.info('a');
    childB.info('b');
    unsub();

    expect(captured.map((e) => e.uin)).toEqual([undefined, 100, 200]);
  });

  it('child() can be chained; later uin wins, earlier meta is preserved', async () => {
    const log = createLogger('Bridge').child({ uin: 100, foo: 'first' }).child({ bar: 'second' });
    const captured: LogEntry[] = [];
    const unsub = subscribeLogs((e) => captured.push(e));
    log.info('chained');
    unsub();

    // uin from first child survives through the second (which only sets bar)
    expect(captured).toHaveLength(1);
    expect(captured[0]!.uin).toBe(100);
  });

  it('writes the per-UIN sub-file in addition to the shared file', async () => {
    const log = createLogger('Bridge').child({ uin: 67890 });
    log.info('to file');
    await _resetFileTransportForTesting();

    const sharedFiles = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.log'));
    expect(sharedFiles).toHaveLength(1);
    const sharedPath = path.join(tmpDir, sharedFiles[0]!);
    expect(fs.readFileSync(sharedPath, 'utf8')).toContain('[67890]');

    const uinSubDir = path.join(tmpDir, '67890');
    expect(fs.existsSync(uinSubDir)).toBe(true);
    const uinFiles = fs.readdirSync(uinSubDir).filter((f) => f.endsWith('.log'));
    expect(uinFiles).toHaveLength(1);
    expect(fs.readFileSync(path.join(uinSubDir, uinFiles[0]!), 'utf8'))
      .toContain('to file');
  });

  it('lines without uin go only to the shared file', async () => {
    const log = createLogger('App');
    log.info('no uin here');
    await _resetFileTransportForTesting();

    const shared = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.log'));
    expect(shared).toHaveLength(1);
    // No numeric sub-dirs should have been created.
    const subDirs = fs.readdirSync(tmpDir, { withFileTypes: true })
      .filter((d) => d.isDirectory())
      .map((d) => d.name);
    expect(subDirs).toHaveLength(0);
  });

  it('SNOWLUMA_LOG_PER_UIN=0 suppresses the per-UIN sub-file but keeps the shared one', async () => {
    setEnv({ SNOWLUMA_LOG_PER_UIN: '0' });
    await _resetFileTransportForTesting();

    const log = createLogger('Bridge').child({ uin: 9999 });
    log.info('one line');
    await _resetFileTransportForTesting();

    expect(fs.existsSync(path.join(tmpDir, '9999'))).toBe(false);
    const shared = fs.readdirSync(tmpDir).filter((f) => f.endsWith('.log'));
    expect(shared).toHaveLength(1);
    expect(fs.readFileSync(path.join(tmpDir, shared[0]!), 'utf8'))
      .toContain('one line');
  });

  it('SNOWLUMA_LOG_FILE=0 also suppresses per-UIN files', async () => {
    setEnv({ SNOWLUMA_LOG_FILE: '0' });
    await _resetFileTransportForTesting();

    const log = createLogger('Bridge').child({ uin: 1 });
    log.info('hi');
    await _resetFileTransportForTesting();

    const entries = fs.readdirSync(tmpDir);
    expect(entries).toHaveLength(0);
  });
});
