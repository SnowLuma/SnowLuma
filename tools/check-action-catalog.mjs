#!/usr/bin/env node
// Same catalog gate as the CI `test` job. Keep the git invocation and
// failure text in lockstep with `.github/workflows/ci.yml`.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

function runGit(args, { inherit = false } = {}) {
  return spawnSync('git', args, {
    cwd: repoRoot,
    encoding: 'utf-8',
    stdio: inherit ? 'inherit' : ['ignore', 'pipe', 'pipe'],
  });
}

const status = runGit([
  'status',
  '--porcelain=v1',
  '--untracked-files=all',
  '--',
  'packages/mcp/src/generated',
]);
if (status.status !== 0) {
  process.stderr.write(status.stderr || 'git status failed\n');
  process.exit(status.status === null ? 1 : status.status);
}

const catalogStatus = (status.stdout || '').trim();
if (!catalogStatus) process.exit(0);

runGit(['diff', '--', 'packages/mcp/src/generated'], { inherit: true });
process.stdout.write(`${catalogStatus}\n`);
process.stderr.write(
  '::error::Generated action catalog is stale. Run `pnpm --filter @snowluma/mcp gen` and commit packages/mcp/src/generated/.\n',
);
process.exit(1);
