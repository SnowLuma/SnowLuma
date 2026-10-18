import fs from 'node:fs';
import path from 'node:path';

const root = path.resolve(process.argv[2] ?? 'dist');
const entryPoint = path.join(root, 'index.mjs');

if (!fs.statSync(root, { throwIfNoEntry: false })?.isDirectory()) {
  throw new Error(`release directory does not exist: ${root}`);
}
if (!fs.statSync(entryPoint, { throwIfNoEntry: false })?.isFile()) {
  throw new Error(`release entry point must be at the archive root: ${entryPoint}`);
}

const release = JSON.parse(fs.readFileSync(path.join(root, 'release.json'), 'utf8'));
const runtimePackage = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
if (release.version !== runtimePackage.version) {
  throw new Error('release version does not match its runtime package');
}
const actualEntries = fs.readdirSync(root).filter(name => !['node', 'node.exe'].includes(name));
if (JSON.stringify([...release.entries].sort()) !== JSON.stringify(actualEntries.sort())) {
  throw new Error('release file manifest does not match the packaged files');
}

const sqliteRoot = path.join(root, 'native', 'sqlite');
const sqlite = JSON.parse(fs.readFileSync(path.join(sqliteRoot, 'manifest.json'), 'utf8'));
if (release.target !== sqlite.target) {
  throw new Error('release target does not match its native artifacts');
}
if (sqlite.package !== '@appthreat/sqlite3' || sqlite.version !== '9.1.0' || sqlite.nativeInterface !== 1
  || !/^(win32|linux|darwin)-(x64|arm64)$/.test(sqlite.target)) {
  throw new Error('release has an invalid SQLite native manifest');
}
const expectedSqliteFiles = (sqlite.target.startsWith('linux-')
  ? ['@appthreat+sqlite3.glibc.node', '@appthreat+sqlite3.musl.node']
  : ['@appthreat+sqlite3.node']).map(file => `prebuilds/${sqlite.target}/${file}`);
if (JSON.stringify(sqlite.files) !== JSON.stringify(expectedSqliteFiles)) {
  throw new Error('release SQLite manifest does not contain the required platform/libc variants');
}
for (const file of [...expectedSqliteFiles, 'LICENSE.sqlite3']) {
  if (!fs.statSync(path.join(sqliteRoot, file), { throwIfNoEntry: false })?.isFile()) {
    throw new Error(`release is missing SQLite runtime input: ${file}`);
  }
}

const forbidden = [];
const pending = [root];
while (pending.length > 0) {
  const directory = pending.pop();
  if (!directory) continue;

  for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const absolute = path.join(directory, entry.name);
    if (/snowluma/i.test(entry.name)) {
      forbidden.push(path.relative(root, absolute));
    }
    pending.push(absolute);
  }
}

if (forbidden.length > 0) {
  throw new Error(`release contains forbidden directory names:\n${forbidden.join('\n')}`);
}

console.log(`Release layout verified: ${root}`);
