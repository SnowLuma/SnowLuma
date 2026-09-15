#!/usr/bin/env node
// One-shot release driver.
//
//   pnpm release <version>           # full pipeline: dev → Promote → main → tag
//   pnpm release <version> --no-wait # bump+push dev only, do main+tag manually
//   pnpm release <version> --dry-run # print plan, change nothing
//
// What it does, in order:
//   1. Sanity-check: on `dev`, clean tree. Must not be behind origin/dev.
//      Already being this version's `chore(release):` commit is a resume
//      (after a dropped push, a failed fetch-while-waiting, or a failed
//      tag push). Re-run `pnpm release <version>` as many times as needed.
//   2. Full CI suite (`node tools/ci-check.mjs`) — the same commands as
//      `.github/workflows/ci.yml`. Skipped on resume. Fail here instead
//      of after the bump.
//   3. `pnpm bump <version>` (writes every package.json).
//   4. Commit `chore(release): vX.Y.Z` — that prefix triggers the
//      Promote workflow, which points `main` at the dev tip. Skipped
//      when HEAD is already that commit.
//   5. Push to origin/dev (retries transient HTTPS / TLS failures).
//   6. (Unless `--no-wait`) poll until `origin/main` equals the dev
//      tip we just pushed, then fetch and fast-forward `main` to
//      `origin/main`, create `vX.Y.Z` tag, push it — that triggers
//      `release.yml`. Fetch / tag push also retry.
//   7. Switch back to `dev` so the next `git log` view is back where
//      you were.
//
// Re-run the same `pnpm release <version>` after any mid-pipeline
// failure (push, wait, tag). Do not amend the release commit.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

// ───────────── arg parsing ─────────────

const args = process.argv.slice(2);
const flags = new Set(args.filter(a => a.startsWith('--')));
const positional = args.filter(a => !a.startsWith('--'));

const version = positional[0];
const dryRun = flags.has('--dry-run');
const noWait = flags.has('--no-wait');

if (!version) {
  console.error('Usage: pnpm release <version> [--no-wait] [--dry-run]');
  console.error('Example: pnpm release 1.8.0');
  process.exit(1);
}
if (!/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)) {
  console.error(`Invalid semver: "${version}"`);
  process.exit(1);
}

const tag = `v${version}`;
const releaseCommit = `chore(release): ${tag}`;

// ───────────── shell helpers ─────────────

function sh(cmd, { capture = false, allowFail = false } = {}) {
  if (dryRun) {
    console.log(`[dry-run] $ ${cmd}`);
    return '';
  }
  if (capture) {
    return execSync(cmd, { cwd: repoRoot, encoding: 'utf-8' }).trim();
  }
  const result = spawnSync(cmd, { cwd: repoRoot, shell: true, stdio: 'inherit' });
  if (result.status !== 0 && !allowFail) {
    throw new Error(`Command failed: ${cmd}`);
  }
  return '';
}

function sleepSync(ms) {
  execSync(`sleep ${Math.max(1, Math.ceil(ms / 1000))}`);
}

function gitOk(cmd) {
  if (dryRun) {
    console.log(`[dry-run] $ ${cmd}`);
    return true;
  }
  const result = spawnSync(cmd, { cwd: repoRoot, shell: true, stdio: 'inherit' });
  return result.status === 0;
}

/** Retry git fetch / push. TLS drops after a successful commit used to abort
 *  the whole pipeline; re-run `pnpm release <version>` to resume. */
function shRetry(cmd, { attempts = 8 } = {}) {
  if (dryRun) {
    console.log(`[dry-run] $ ${cmd}`);
    return '';
  }
  let delayMs = 2000;
  for (let i = 1; i <= attempts; i++) {
    if (i > 1) info(`retry ${i}/${attempts}: ${cmd}`);
    if (gitOk(cmd)) return '';
    if (i === attempts) {
      throw new Error(
        `Command failed after ${attempts} attempts: ${cmd}\n` +
        `Re-run: pnpm release ${version}`,
      );
    }
    warn(`failed, retrying in ${delayMs / 1000}s`);
    sleepSync(delayMs);
    delayMs = Math.min(delayMs * 2, 30_000);
  }
  return '';
}

function headSubject() {
  return shCapture('git log -1 --format=%s');
}

function packageVersion() {
  return JSON.parse(readFileSync(path.join(repoRoot, 'package.json'), 'utf-8')).version;
}

function headIsThisRelease() {
  return headSubject() === releaseCommit && packageVersion() === version;
}

/** The bump commit for this version, even if later tooling commits sit on top. */
function thisReleaseSha() {
  try {
    const sha = shCapture(`git log -1 --format=%H --grep=${JSON.stringify(`^${releaseCommit}$`)}`);
    return sha || null;
  } catch {
    return null;
  }
}

function shCapture(cmd) {
  return execSync(cmd, { cwd: repoRoot, encoding: 'utf-8' }).trim();
}

function which(bin) {
  try {
    execSync(`command -v ${bin}`, { stdio: 'ignore' });
    return true;
  } catch { return false; }
}

function ok(msg)   { console.log(`\x1b[32m✓\x1b[0m ${msg}`); }
function info(msg) { console.log(`\x1b[36mi\x1b[0m ${msg}`); }
function warn(msg) { console.log(`\x1b[33m!\x1b[0m ${msg}`); }

function printManualFinish() {
  info(`Re-run the same command to resume: pnpm release ${version}`);
}

function packageVersionAt(sha) {
  return JSON.parse(shCapture(`git show ${sha}:package.json`)).version;
}

// ───────────── step 1: preflight ─────────────

function preflightFail(msg) {
  if (dryRun) { warn(`[dry-run] would have aborted: ${msg}`); return; }
  console.error(msg);
  process.exit(1);
}

function preflight() {
  const branch = shCapture('git rev-parse --abbrev-ref HEAD');
  if (branch !== 'dev') {
    preflightFail(`Must be on \`dev\` to start a release. Current: \`${branch}\``);
  }

  const dirty = shCapture('git status --porcelain');
  if (dirty) {
    preflightFail(`Working tree is not clean. Commit or stash first.\n${dirty}`);
  }

  // Make sure we're not behind origin/dev so the bump commit doesn't
  // collide with someone else's push. Already being this release commit
  // (in sync, or ahead by the unpushed bump) is a resume.
  shRetry('git fetch origin refs/heads/dev:refs/remotes/origin/dev');
  const local = shCapture('git rev-parse dev');
  const remote = shCapture('git rev-parse origin/dev');
  if (local !== remote) {
    const ahead  = shCapture('git rev-list --count origin/dev..dev');
    const behind = shCapture('git rev-list --count dev..origin/dev');
    if (behind !== '0') {
      preflightFail(`dev is behind origin/dev (behind=${behind}). Pull first.`);
    }
    if (headIsThisRelease()) {
      warn(`dev is ahead of origin/dev by ${ahead}; HEAD is ${releaseCommit}, will resume`);
    } else {
      preflightFail(`dev is not in sync with origin/dev (ahead=${ahead}, behind=${behind}). Pull / push first.`);
    }
  }

  if (!dryRun) ok(`on dev, clean, ready to release ${tag}`);
}

function runCiSuite() {
  if (!dryRun && headIsThisRelease()) {
    warn(`HEAD is already ${releaseCommit}; skipping CI suite (resume)`);
    return;
  }
  info('running the full CI suite (same commands as .github/workflows/ci.yml)');
  sh('node tools/ci-check.mjs');
  if (!dryRun) ok('CI suite passed');
}

// ───────────── step 2-4: bump + commit + push dev ─────────────

function bumpAndPushDev() {
  if (!dryRun && headIsThisRelease()) {
    warn(`HEAD is already ${releaseCommit}; skipping bump and commit`);
  } else {
    sh(`node tools/bump-version.mjs ${version}`);
    ok(`bumped all package.json files to ${version}`);

    if (dryRun) {
      info(`would commit "${releaseCommit}" and push origin dev`);
      return;
    }

    const changed = shCapture('git status --porcelain');
    if (!changed) {
      warn(`no version changes — package.json already at ${version}, skipping commit`);
    } else {
      sh('git add package.json packages/*/package.json');
      sh(`git commit -m "${releaseCommit}"`);
      ok(`committed ${releaseCommit}`);
    }
  }

  const local = shCapture('git rev-parse dev');
  const remote = shCapture('git rev-parse origin/dev');
  if (!dryRun && local === remote) {
    info('origin/dev already has this tip; skipping push');
    return;
  }
  shRetry('git push origin dev');
  ok(`pushed to origin/dev — Promote workflow should kick off shortly`);
}

// ───────────── step 5: wait for main to match dev, then tag ─────────────

function promoteRunFailed(expectedSha) {
  if (!which('gh')) return null;
  try {
    const list = shCapture('gh run list --workflow=promote-dev-to-main.yml --limit 8 --json conclusion,headSha,url,status');
    const runs = JSON.parse(list);
    return runs.find((run) => run.headSha === expectedSha && run.conclusion === 'failure') ?? null;
  } catch (error) {
    warn(`gh run list failed: ${error.message}`);
    return null;
  }
}

function localTagSha() {
  const result = spawnSync('git', ['rev-parse', '-q', '--verify', `${tag}^{commit}`], {
    cwd: repoRoot,
    encoding: 'utf-8',
  });
  if (result.status !== 0) return null;
  return (result.stdout || '').trim();
}

function remoteTagSha() {
  try {
    const out = shCapture(`git ls-remote --tags origin refs/tags/${tag} refs/tags/${tag}^{}`);
    if (!out) return null;
    const lines = out.split('\n').filter(Boolean);
    const peeled = lines.find((line) => line.includes('^{}'));
    return (peeled || lines[0]).split(/\s+/)[0];
  } catch {
    return null;
  }
}

function originMainSha() {
  try {
    return shCapture('git rev-parse refs/remotes/origin/main');
  } catch {
    return null;
  }
}

function ensureTag(expectedSha) {
  const local = localTagSha();
  if (local && local !== expectedSha) {
    throw new Error(
      `Local tag ${tag} points at ${local.slice(0, 12)}, expected ${expectedSha.slice(0, 12)}. ` +
      `Delete it first if you meant to retarget: git tag -d ${tag}`,
    );
  }
  if (!local) sh(`git tag ${tag} ${expectedSha}`);
  else info(`tag ${tag} already points at ${expectedSha.slice(0, 12)}`);

  const remote = remoteTagSha();
  if (remote === expectedSha) {
    info(`origin already has ${tag} at ${expectedSha.slice(0, 12)}`);
    return;
  }
  if (remote && remote !== expectedSha) {
    throw new Error(
      `origin ${tag} points at ${remote.slice(0, 12)}, expected ${expectedSha.slice(0, 12)}. ` +
      `Not moving a live tag.`,
    );
  }
  shRetry(`git push origin ${tag}`);
  ok(`tagged and pushed ${tag} — release workflow will pick it up`);
}

async function waitUntilMainIs(expectedSha) {
  info(`waiting until origin/main equals dev @ ${expectedSha.slice(0, 12)}...`);
  info('press Ctrl-C if you want to stop; re-run the same command to resume.');

  const startedAt = Date.now();
  const TIMEOUT_MS = 30 * 60 * 1000;
  const POLL_MS = 15 * 1000;

  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (gitOk('git fetch origin refs/heads/main:refs/remotes/origin/main')) {
      const mainSha = originMainSha();
      if (mainSha === expectedSha) {
        ok(`origin/main is dev @ ${expectedSha.slice(0, 12)}`);
        return true;
      }
    } else {
      warn('fetch origin/main failed; will keep waiting (re-run this command if you abort)');
    }

    const failed = promoteRunFailed(expectedSha);
    if (failed) {
      warn(`a Promote run failed for ${expectedSha.slice(0, 12)}: ${failed.url}`);
      warn('still waiting in case a later Promote succeeds');
    }

    await new Promise((resolve) => setTimeout(resolve, POLL_MS));
  }

  warn('30-minute timeout reached without origin/main matching dev.');
  printManualFinish();
  return false;
}

async function waitAndTag() {
  const expectedSha = dryRun
    ? 'dry-run'
    : (thisReleaseSha() || shCapture('git rev-parse dev'));

  if (dryRun) {
    info(`would wait until origin/main equals dev @ ${expectedSha.slice(0, 12)}`);
    info(`would tag ${tag} and push origin ${tag}`);
    return;
  }

  const alreadyTagged = remoteTagSha() === expectedSha || localTagSha() === expectedSha;
  if (alreadyTagged && remoteTagSha() === expectedSha) {
    ok(`origin already has ${tag} at ${expectedSha.slice(0, 12)}; nothing to do`);
    return;
  }

  gitOk('git fetch origin refs/heads/main:refs/remotes/origin/main');
  if (originMainSha() !== expectedSha) {
    const ready = await waitUntilMainIs(expectedSha);
    if (!ready) return;
  } else {
    ok(`origin/main already equals the release commit @ ${expectedSha.slice(0, 12)}`);
  }

  const taggedVersion = packageVersionAt(expectedSha);
  if (taggedVersion !== version) {
    warn(`release commit package.json is ${taggedVersion} but you asked for ${version}.`);
    warn('Tagging anyway, but the release artifact name may not match.');
  }

  ensureTag(expectedSha);
}

// ───────────── go ─────────────

(async () => {
  console.log(`Release pipeline → ${tag}${dryRun ? ' (dry-run)' : ''}\n`);
  preflight();
  runCiSuite();
  bumpAndPushDev();

  if (noWait) {
    info('--no-wait set; not waiting for origin/main to match dev.');
    printManualFinish();
    return;
  }

  await waitAndTag();
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
