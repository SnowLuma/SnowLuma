import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  listPerUinOneBotConfigFiles,
  readBackupConfigFile,
} from '../src/webui/server';

describe('backup filesystem adapter', () => {
  let root: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'snowluma-backup-http-'));
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('treats only a missing file as absent', () => {
    expect(readBackupConfigFile(root, 'missing.json')).toBeNull();

    fs.mkdirSync(path.join(root, 'runtime.json'));
    expect(() => readBackupConfigFile(root, 'runtime.json')).toThrow();
  });

  it('treats only a missing config directory as an empty OneBot list', () => {
    expect(listPerUinOneBotConfigFiles(path.join(root, 'missing'))).toEqual([]);

    const notDirectory = path.join(root, 'not-a-directory');
    fs.writeFileSync(notDirectory, 'x');
    expect(() => listPerUinOneBotConfigFiles(notDirectory)).toThrow();
  });
});
