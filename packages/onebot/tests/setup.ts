import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterAll } from 'vitest';

const originalTempEnv = {
  TMPDIR: process.env.TMPDIR,
  TMP: process.env.TMP,
  TEMP: process.env.TEMP,
};
const originalCwd = process.cwd();
const testTempDir = fs.mkdtempSync(path.join(
  os.tmpdir(),
  `snowluma-onebot-vitest-${process.pid}-${process.env.VITEST_POOL_ID ?? '0'}-`,
));

process.env.TMPDIR = testTempDir;
process.env.TMP = testTempDir;
process.env.TEMP = testTempDir;

// Runtime state resolves against cwd, not the package root: `config/onebot_<uin>.json`
// (the `persistDefaults` materialization) and the per-UIN stores under `data/`. The
// manager's real session-start path persists that config even when a test injects a
// fake instance, so `manager-lifecycle.test.ts` alone left
// `packages/onebot/config/onebot_10001.json` behind — an untracked file carrying a
// generated access token that dirtied `git status` (and `git add -A`) on every run.
// Pin cwd to this worker's temp dir so each relative write stays contained. Vitest
// runs one file per forked process, so the chdir cannot cross into another file.
process.chdir(testTempDir);

// The package root must stay untouched by tests. Snapshot it before the suite so an
// operator-created directory (or a leftover from an earlier run) is never blamed on
// the current one.
const rootEntriesBefore = new Set(fs.readdirSync(originalCwd));

afterAll(() => {
  // Leave the temp dir before deleting it.
  process.chdir(originalCwd);
  for (const [name, value] of Object.entries(originalTempEnv)) {
    if (value === undefined) delete process.env[name];
    else process.env[name] = value;
  }
  fs.rmSync(testTempDir, { recursive: true, force: true });

  const added = fs.readdirSync(originalCwd).filter((name) => !rootEntriesBefore.has(name));
  if (added.length > 0) {
    throw new Error(
      `OneBot tests created ${added.join(', ')} in ${originalCwd}. Runtime state must resolve `
      + 'under the per-worker temp dir this setup chdir-s into; a test that switches cwd itself '
      + 'must restore it before its asynchronous work settles.',
    );
  }
});
