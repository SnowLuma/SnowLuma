#!/usr/bin/env node
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const repoRoot = path.resolve(import.meta.dirname, '..');
const targetDir = path.resolve(process.argv[2] ?? path.join(repoRoot, 'packages/runtime/native'));

const MAX_SYMBOLS = {
  GLIBC: process.env.SNOWLUMA_MAX_GLIBC ?? '2.36',
  GLIBCXX: process.env.SNOWLUMA_MAX_GLIBCXX ?? '3.4.30',
  CXXABI: process.env.SNOWLUMA_MAX_CXXABI ?? '1.3.13',
};

const LINUX_NATIVE_RE = /(?:^|\/)(?:(?:snowluma|websocket)-linux-[^/]+\.(?:node|so)|ffmpegAddon\.linux\.[^/]+\.node)$/;
const SYMBOL_RE = /\b(GLIBCXX|CXXABI|GLIBC)_([0-9]+(?:\.[0-9]+)*)\b/g;

function walk(dir) {
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const fullPath = path.join(dir, entry.name);
    if (entry.isDirectory()) return walk(fullPath);
    if (!entry.isFile()) return [];
    return [fullPath];
  });
}

function versionParts(version) {
  return version.split('.').map((part) => Number.parseInt(part, 10));
}

function compareVersion(a, b) {
  const left = versionParts(a);
  const right = versionParts(b);
  const maxLen = Math.max(left.length, right.length);
  for (let i = 0; i < maxLen; i += 1) {
    const diff = (left[i] ?? 0) - (right[i] ?? 0);
    if (diff !== 0) return diff;
  }
  return 0;
}

function collectSymbols(filePath) {
  let output = '';
  try {
    output = execFileSync('strings', [filePath], { encoding: 'utf8' });
  } catch (error) {
    throw new Error(`failed to inspect ${filePath}: ${error.message}`);
  }

  const symbols = new Map();
  for (const match of output.matchAll(SYMBOL_RE)) {
    const [, namespace, version] = match;
    const key = `${namespace}_${version}`;
    symbols.set(key, { namespace, version });
  }
  return [...symbols.values()].sort((a, b) => {
    const ns = a.namespace.localeCompare(b.namespace);
    return ns || compareVersion(a.version, b.version);
  });
}

function main() {
  if (!fs.existsSync(targetDir)) {
    throw new Error(`native directory does not exist: ${targetDir}`);
  }

  const nativeFiles = walk(targetDir).filter((filePath) =>
    LINUX_NATIVE_RE.test(filePath.replaceAll(path.sep, '/')),
  );

  if (nativeFiles.length === 0) {
    console.log(`[native-abi] no Linux native binaries found under ${targetDir}`);
    return;
  }

  const failures = [];
  for (const filePath of nativeFiles) {
    const relPath = path.relative(repoRoot, filePath);
    const symbols = collectSymbols(filePath);
    const tooNew = symbols.filter(
      ({ namespace, version }) => compareVersion(version, MAX_SYMBOLS[namespace]) > 0,
    );
    if (tooNew.length > 0) {
      failures.push({
        relPath,
        symbols: tooNew.map(({ namespace, version }) => `${namespace}_${version}`),
      });
    }
  }

  if (failures.length > 0) {
    console.error('[native-abi] Linux native ABI check failed.');
    console.error('[native-abi] Docker images currently run on Debian bookworm; keep Linux native binaries compatible with:');
    for (const [namespace, version] of Object.entries(MAX_SYMBOLS)) {
      console.error(`[native-abi]   ${namespace}_${version} or older`);
    }
    for (const failure of failures) {
      console.error(`[native-abi] ${failure.relPath}: ${failure.symbols.join(', ')}`);
    }
    process.exit(1);
  }

  console.log(`[native-abi] OK: ${nativeFiles.length} Linux native binaries are bookworm-compatible`);
}

try {
  main();
} catch (error) {
  console.error(`[native-abi] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
