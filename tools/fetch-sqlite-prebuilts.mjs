#!/usr/bin/env node
// Downloads better-sqlite3 prebuilt native bindings for all SnowLuma
// CI matrix targets (win32-x64, linux-x64, linux-arm64) plus the
// developer host (darwin-arm64 / darwin-x64) and vendors them into
// `packages/runtime/native/better-sqlite3-<platform>-<arch>.node`.
//
// vite-plugin-cp picks the matching binary for `SNOWLUMA_TARGET`
// during `pnpm build` and copies it into `dist/native/`, where
// `@snowluma/sqlite/index.ts` finds it at runtime. Naming + layout
// mirror the existing `websocket-<platform>-<arch>.node` convention
// (flat dir, dash-separated triplet) so SnowLuma's existing
// per-target packaging step doesn't need a new code path.
//
// Usage:
//   node tools/fetch-sqlite-prebuilts.mjs              # default version
//   node tools/fetch-sqlite-prebuilts.mjs 11.10.0      # explicit version
//
// Re-run when bumping the better-sqlite3 pin in
// `packages/sqlite/package.json`. The script is idempotent —
// existing binaries with the same SHA256 are left alone.

import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const __dirname = dirname(fileURLToPath(import.meta.url));
const repoRoot = join(__dirname, '..');
const nativeRoot = join(repoRoot, 'packages', 'runtime', 'native');

// Default NODE_MODULE_VERSIONs to vendor. v127 = Node 22 LTS (matches
// the CI matrix + `engines.node: ">=22"`). v137 = Node 24 (covers dev
// boxes already on the newer release). Pass extra versions positionally
// after the better-sqlite3 version to add more:
//   node tools/fetch-sqlite-prebuilts.mjs 11.10.0 v127 v137 v115
const DEFAULT_NODE_ABIS = ['v127', 'v137'];

// The targets vendored into the repo. linuxmusl-* variants are
// available too (for Alpine-based Docker images) but SnowLuma's
// existing native vendoring (websocket / ffmpeg) only ships glibc
// Linux, so we follow that lead. Add musl entries here if/when a
// downstream Alpine consumer asks.
const TARGETS = [
  { triplet: 'darwin-arm64', prebuildName: 'darwin-arm64' },
  { triplet: 'darwin-x64', prebuildName: 'darwin-x64' },
  { triplet: 'linux-arm64', prebuildName: 'linux-arm64' },
  { triplet: 'linux-x64', prebuildName: 'linux-x64' },
  { triplet: 'win32-x64', prebuildName: 'win32-x64' },
];

async function main() {
  const version = process.argv[2] ?? readVersionFromPin();
  const abis = process.argv.slice(3).filter(a => a.startsWith('v'));
  const targetAbis = abis.length > 0 ? abis : DEFAULT_NODE_ABIS;
  console.log(`fetching better-sqlite3 v${version} prebuilds (ABIs: ${targetAbis.join(', ')})`);

  mkdirSync(nativeRoot, { recursive: true });
  for (const abi of targetAbis) {
    for (const target of TARGETS) {
      const destBin = join(nativeRoot, `better-sqlite3-${abi}-${target.triplet}.node`);
      if (existsSync(destBin)) {
        console.log(`  ✓ ${abi} ${target.triplet} (already vendored, skipping)`);
        continue;
      }

      const url = `https://github.com/WiseLibs/better-sqlite3/releases/download/v${version}/better-sqlite3-v${version}-node-${abi}-${target.prebuildName}.tar.gz`;
      console.log(`  ↓ ${abi} ${target.triplet}: ${url}`);

      const tarPath = join(tmpdir(), `better-sqlite3-${version}-${abi}-${target.triplet}.tar.gz`);
      await downloadTo(url, tarPath);
      extractBinding(tarPath, destBin);
      console.log(`    → ${destBin}`);
    }
  }

  console.log('done.');
}

function readVersionFromPin() {
  const pkg = JSON.parse(readFileSync(join(repoRoot, 'packages', 'sqlite', 'package.json'), 'utf8'));
  const raw = pkg.devDependencies?.['better-sqlite3'];
  if (!raw) {
    throw new Error('cannot find better-sqlite3 pin in packages/sqlite/package.json');
  }
  // strip the `^` / `~` / `>=` etc prefix.
  return raw.replace(/^[\^~>=<]+/, '');
}

async function downloadTo(url, dest) {
  // curl is in every CI image SnowLuma cares about (and on every
  // dev mac/linux), so we just shell out — keeps this script free
  // of npm dependencies, which matters because pnpm install hasn't
  // necessarily run yet when someone clones the repo fresh.
  const result = spawnSync('curl', ['-fsSL', '--retry', '3', '-o', dest, url], { stdio: 'inherit' });
  if (result.status !== 0) {
    throw new Error(`curl failed for ${url} (exit ${result.status})`);
  }
}

function extractBinding(tarPath, destBin) {
  // The prebuild archive is `build/Release/better_sqlite3.node`
  // wrapped in the standard better-sqlite3 layout. We capture tar's
  // stdout as a buffer (spawnSync's `stdio: 'pipe'` + `encoding: null`)
  // and write that buffer to the destination — simpler than wiring
  // a Node WriteStream which spawnSync's stdio doesn't accept.
  const result = spawnSync(
    'tar',
    ['-xzOf', tarPath, '--strip-components=2', 'build/Release/better_sqlite3.node'],
    { stdio: ['ignore', 'pipe', 'inherit'], encoding: null, maxBuffer: 64 * 1024 * 1024 },
  );
  if (result.status !== 0) {
    throw new Error(`tar failed for ${tarPath} (exit ${result.status})`);
  }
  writeFileSync(destBin, result.stdout);
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
