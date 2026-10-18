#!/usr/bin/env node
// Sync the `version` field across the monorepo root and every workspace package.
// Usage: pnpm bump [version]; without an argument, sync the root version.
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parseVersion } from '../packages/common/src/semver.ts';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const nextVersion = process.argv[2] ?? JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf8')).version;
if (!parseVersion(nextVersion)) {
  console.error(`Invalid semver: "${nextVersion}"`);
  process.exit(1);
}

async function updatePkg(file) {
  const raw = await readFile(file, 'utf-8');
  const pkg = JSON.parse(raw);
  const prev = pkg.version;
  if (prev === nextVersion) {
    console.log(`  = ${path.relative(repoRoot, file)} (already ${nextVersion})`);
    return;
  }
  pkg.version = nextVersion;
  // Preserve trailing newline if the original file had one.
  const trailing = raw.endsWith('\n') ? '\n' : '';
  await writeFile(file, JSON.stringify(pkg, null, 2) + trailing);
  console.log(`  ✓ ${path.relative(repoRoot, file)}: ${prev} → ${nextVersion}`);
}

const files = [path.join(repoRoot, 'package.json')];
const packagesDir = path.join(repoRoot, 'packages');
for (const entry of await readdir(packagesDir, { withFileTypes: true })) {
  if (!entry.isDirectory()) continue;
  const pkgFile = path.join(packagesDir, entry.name, 'package.json');
  if (existsSync(pkgFile)) files.push(pkgFile);
}

console.log(`Bumping ${files.length} package.json files to ${nextVersion}:`);
for (const file of files) await updatePkg(file);
console.log('Done.');
