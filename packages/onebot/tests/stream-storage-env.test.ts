import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createStreamStorage } from '../src/stream-storage';

describe('SNOWLUMA_STREAM_DIR', () => {
  const created: string[] = [];

  afterEach(() => {
    for (const directory of created.splice(0)) {
      fs.rmSync(directory, { recursive: true, force: true });
    }
  });

  it('uses the system temp directory by default', () => {
    const storage = createStreamStorage({});
    expect(storage.root.endsWith(`${path.sep}onebot-stream`)).toBe(true);
    created.push(storage.root);
  });

  it('uses a caller directory when the variable is set', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-stream-env-'));
    created.push(root);
    const storage = createStreamStorage({ SNOWLUMA_STREAM_DIR: root });
    expect(storage.root).toBe(fs.realpathSync(root));
  });

  it('falls back when the variable does not name a usable directory', () => {
    const file = path.join(os.tmpdir(), `snowluma-stream-not-dir-${process.pid}`);
    fs.writeFileSync(file, 'x');
    created.push(file);
    const storage = createStreamStorage({ SNOWLUMA_STREAM_DIR: file });
    expect(storage.root.endsWith(`${path.sep}onebot-stream`)).toBe(true);
  });
});