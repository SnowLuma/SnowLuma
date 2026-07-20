import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const upstreamDir = path.join(repoRoot, '.cache', 'lagrange-core');
const hostProject = path.join(repoRoot, 'packages', 'lagrange-host', 'SnowLuma.ProtocolHost.csproj');
const patchFile = path.join(repoRoot, 'packages', 'lagrange-host', 'lagrange-raw-packet.patch');
const nativeDir = path.join(repoRoot, 'packages', 'runtime', 'native');
const upstreamUrl = 'https://github.com/LagrangeDev/Lagrange.Core.git';
const upstreamCommit = '9efbb19bc5d168de538c586023529729b920681f';
const gplLicenseUrl = 'https://raw.githubusercontent.com/spdx/license-list-data/main/text/GPL-3.0-only.txt';
const gplLicenseSha256 = 'fb981668c18a279e285fc4d83fba1e836cc84dd4daa73c9697d3cfd2d8aca6e0';
const dotnet = process.env.SNOWLUMA_DOTNET || 'dotnet';

const target = process.env.SNOWLUMA_TARGET ?? `${process.platform}-${process.arch}`;
const ridByTarget = {
  'win32-x64': 'win-x64',
  'linux-x64': 'linux-x64',
  'linux-arm64': 'linux-arm64',
};
const rid = ridByTarget[target];
if (!rid) throw new Error(`Unsupported Lagrange host target: ${target}`);

fs.mkdirSync(path.dirname(upstreamDir), { recursive: true });
if (!fs.existsSync(path.join(upstreamDir, '.git'))) {
  exec('git', ['clone', '--filter=blob:none', '--no-checkout', upstreamUrl, upstreamDir]);
}
exec('git', ['fetch', '--depth', '1', 'origin', upstreamCommit], upstreamDir);
exec('git', ['checkout', '--force', upstreamCommit], upstreamDir);
exec('git', ['clean', '-fd'], upstreamDir);
exec('git', ['apply', '--check', patchFile], upstreamDir);
exec('git', ['apply', patchFile], upstreamDir);

const publishDir = path.join(upstreamDir, '.snowluma-publish', rid);
exec(dotnet, [
  'publish', hostProject,
  '-c', 'Release',
  '-r', rid,
  '--self-contained', 'true',
  `-p:LagrangeRoot=${upstreamDir}`,
  '-o', publishDir,
]);

fs.mkdirSync(nativeDir, { recursive: true });
const extension = target.startsWith('win32-') ? '.exe' : '';
const source = path.join(publishDir, `snowluma-lagrange-host${extension}`);
const destination = path.join(nativeDir, `snowluma-lagrange-host-${target}${extension}`);
fs.copyFileSync(source, destination);
await downloadVerifiedFile(
  gplLicenseUrl,
  path.join(nativeDir, 'Lagrange.Core.LICENSE'),
  gplLicenseSha256,
);
if (!extension) fs.chmodSync(destination, 0o755);
console.log(`Built ${path.relative(repoRoot, destination)}`);

function exec(command, args, cwd = repoRoot) {
  execFileSync(command, args, { cwd, stdio: 'inherit' });
}

async function downloadVerifiedFile(url, destinationPath, expectedSha256) {
  const response = await fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to download ${url}: HTTP ${response.status}`);
  }

  const contents = Buffer.from(await response.arrayBuffer());
  const actualSha256 = createHash('sha256').update(contents).digest('hex');
  if (actualSha256 !== expectedSha256) {
    throw new Error(`Checksum mismatch for ${url}: ${actualSha256}`);
  }

  fs.writeFileSync(destinationPath, contents);
}
