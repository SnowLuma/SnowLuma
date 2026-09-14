#!/usr/bin/env node

import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync, rmSync } from 'node:fs';
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const packagesRoot = path.join(repoRoot, 'packages');
const coverageRoot = path.join(repoRoot, 'coverage');

function resolveVitestCli(manifestPath) {
  const require = createRequire(manifestPath);
  let directory = path.dirname(require.resolve('vitest'));

  while (true) {
    const packagePath = path.join(directory, 'package.json');
    if (existsSync(packagePath)) {
      const manifest = JSON.parse(readFileSync(packagePath, 'utf8'));
      if (manifest.name === 'vitest') {
        const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.vitest;
        if (typeof bin !== 'string') throw new Error('Vitest does not declare a CLI binary');
        return path.resolve(directory, bin);
      }
    }

    const parent = path.dirname(directory);
    if (parent === directory) throw new Error(`Could not resolve Vitest CLI from ${manifestPath}`);
    directory = parent;
  }
}

const workspaces = readdirSync(packagesRoot, { withFileTypes: true })
  .filter((entry) => entry.isDirectory())
  .map((entry) => {
    const directory = path.join(packagesRoot, entry.name);
    const manifestPath = path.join(directory, 'package.json');
    if (!existsSync(manifestPath)) return null;
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
    if (typeof manifest.scripts?.test !== 'string') return null;
    if (typeof manifest.devDependencies?.vitest !== 'string') {
      throw new Error(`${manifest.name ?? entry.name} declares tests without a package-local Vitest dependency`);
    }
    return {
      directory,
      reportDirectory: path.join(coverageRoot, entry.name),
      name: manifest.name ?? entry.name,
      vitestCli: resolveVitestCli(manifestPath),
    };
  })
  .filter(Boolean);

if (workspaces.length === 0) {
  throw new Error('No regular Vitest workspaces found');
}

rmSync(coverageRoot, { recursive: true, force: true });

for (const workspace of workspaces) {
  console.log(`\n[coverage] ${workspace.name}`);
  const result = spawnSync(
    process.execPath,
    [
      workspace.vitestCli,
      'run',
      '--exclude=tests/native/**',
      '--coverage',
      '--coverage.provider=v8',
      `--coverage.reportsDirectory=${workspace.reportDirectory}`,
      '--coverage.reporter=text-summary',
      '--coverage.reporter=json-summary',
      '--coverage.reporter=html',
      '--coverage.include=src/**/*.{js,mjs,cjs,ts,tsx}',
      '--coverage.exclude=src/**/generated/**',
      '--coverage.exclude=src/**/fixtures/**',
      '--coverage.exclude=src/**/*.d.ts',
      '--coverage.exclude=src/**/native/**',
      '--coverage.exclude=dist/**',
      '--coverage.exclude=**/native/**',
    ],
    {
      cwd: workspace.directory,
      stdio: 'inherit',
    },
  );

  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}

console.log(`\n[coverage] Reports written to ${path.relative(repoRoot, coverageRoot)}/`);
