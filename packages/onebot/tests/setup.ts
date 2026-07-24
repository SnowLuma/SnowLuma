import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const originalTempEnv = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
};
const testTempDir = fs.mkdtempSync(path.join(
  os.tmpdir(),
  `snowluma-onebot-vitest-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}-`,
));

process.env.TMPDIR = testTempDir;
process.env.TMP = testTempDir;
process.env.TEMP = testTempDir;

afterAll(() => {
  for (const [name, value] of Object.entries(originalTempEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(testTempDir, { recursive: true, force: true });
});
