#!/usr/bin/env node
// Local replica of `.github/workflows/ci.yml`.
// Every command and step title below must stay identical to that workflow.
// CI jobs run these in parallel after a frozen install; this script runs the
// same commands once each, in that job's internal order, and still executes
// later steps if an earlier one fails — same as four GitHub jobs reporting
// independently.

import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

const checks = [
  ['Install dependencies', 'pnpm install --frozen-lockfile'],
  ['Run all package tests', 'pnpm test'],
  ['Verify generated action catalog is up to date', 'node tools/check-action-catalog.mjs'],
  ['Type check all packages', 'pnpm typecheck'],
  ['Build release inputs', 'pnpm run build:all'],
  ['Lint managed source files', 'pnpm lint'],
];

const failed = [];

for (const [title, command] of checks) {
  console.log(`\n▸ ${title}\n$ ${command}\n`);
  const result = spawnSync(command, {
    cwd: repoRoot,
    shell: true,
    stdio: 'inherit',
    env: process.env,
  });
  const code = result.status === 0 ? 0 : (result.status ?? 1);
  if (code !== 0) {
    failed.push({ title, command, code });
    console.error(`\n✗ ${title} failed (exit ${code})`);
  } else {
    console.log(`\n✓ ${title}`);
  }
}

if (failed.length > 0) {
  console.error('\nCI suite failed:');
  for (const item of failed) {
    console.error(`  - ${item.title}: \`${item.command}\` (exit ${item.code})`);
  }
  process.exit(1);
}

console.log('\nCI suite passed (same commands as .github/workflows/ci.yml).');
