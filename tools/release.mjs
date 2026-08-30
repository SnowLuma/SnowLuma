#!/usr/bin/env node
// One-shot release driver.
//
//   pnpm release <version>           # full pipeline: dev → Promote → main → tag
//   pnpm release <version> --no-wait # bump+push dev only, do main+tag manually
//   pnpm release <version> --dry-run # print plan, change nothing
//
// What it does, in order:
//   1. Sanity-check: on `dev`, clean tree. Must not be behind origin/dev.
//      Ahead-by-one is allowed when HEAD is already this version's
//      `chore(release):` commit (resume after a dropped push).
//   2. `pnpm bump <version>` (writes every package.json).
//   3. Commit `chore(release): vX.Y.Z` — that prefix triggers the
//      Promote workflow, which opens (or updates) the dev→main PR and
//      auto-merges if the GitHub setting allows. Skipped when HEAD is
//      already that commit.
//   4. Push to origin/dev (retries transient HTTPS / TLS failures).
//   5. (Unless `--no-wait`) poll the Promote PR via `gh` until it
//      merges, then fetch and fast-forward `main` to `origin/main`,
//      create `vX.Y.Z` tag, push it — that triggers `release.yml`.
//      Fetch / tag push also retry.
//   6. Switch back to `dev` so the next `git log` view is back where
//      you were.
//
// Re-run the same `pnpm release <version>` after a dropped push; do
// not amend the release commit.

import { execSync, spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

/** Retry git fetch / push. TLS drops after a successful commit used to abort
 *  the whole pipeline with no way to resume except by hand. */
function shRetry(cmd, { attempts = 5 } = {}) {
  if (dryRun) {
    console.log(`[dry-run] $ ${cmd}`);
    return '';
  }
  let delayMs = 2000;
  for (let i = 1; i <= attempts; i++) {
    if (i > 1) info(`retry ${i}/${attempts}: ${cmd}`);
    const result = spawnSync(cmd, { cwd: repoRoot, shell: true, stdio: 'inherit' });
    if (result.status === 0) return '';
    if (i === attempts) {
      const hint = cmd.includes('git push origin dev')
        ? `\nRelease commit is already local. Fix the network and re-run: pnpm release ${version}`
        : '';
      throw new Error(`Command failed after ${attempts} attempts: ${cmd}${hint}`);
    }
    warn(`failed (exit ${result.status}), retrying in ${delayMs / 1000}s`);
    sleepSync(delayMs);
    delayMs *= 2;
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
  info('Once the Promote PR merges, finish with:');
  info(`  pnpm release ${version}`);
  info('or by hand:');
  info('  git fetch origin refs/heads/main:refs/remotes/origin/main');
  info('  git switch main');
  info('  git merge --ff-only origin/main');
  info(`  git tag ${tag} && git push origin ${tag}`);
}

function syncMain() {
  // Use a fully qualified refspec and an explicit fast-forward so release
  // behavior cannot be changed by the caller's pull/rebase configuration.
  shRetry('git fetch origin refs/heads/main:refs/remotes/origin/main --quiet');
  sh('git switch main');
  sh('git merge --ff-only origin/main');

  if (dryRun) return;

  const localMain = shCapture('git rev-parse refs/heads/main');
  const remoteMain = shCapture('git rev-parse refs/remotes/origin/main');
  if (localMain !== remoteMain) {
    throw new Error(
      `Refusing to tag: local main (${localMain.slice(0, 12)}) does not exactly match ` +
      `origin/main (${remoteMain.slice(0, 12)}).`,
    );
  }
  ok('main matches origin/main');
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
  // collide with someone else's push. Ahead-by-one is a resume: the
  // previous run committed the bump then dropped the push.
  shRetry('git fetch origin refs/heads/dev:refs/remotes/origin/dev --quiet');
  const local = shCapture('git rev-parse dev');
  const remote = shCapture('git rev-parse origin/dev');
  if (local !== remote) {
    const ahead  = shCapture('git rev-list --count origin/dev..dev');
    const behind = shCapture('git rev-list --count dev..origin/dev');
    if (behind !== '0') {
      preflightFail(`dev is behind origin/dev (behind=${behind}). Pull first.`);
    }
    if (ahead === '1' && headIsThisRelease()) {
      warn(`dev is ahead of origin/dev by 1; HEAD is ${releaseCommit}, will resume from push`);
    } else {
      preflightFail(`dev is not in sync with origin/dev (ahead=${ahead}, behind=${behind}). Pull / push first.`);
    }
  }

  if (!dryRun) ok(`on dev, clean, ready to release ${tag}`);
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

  shRetry('git push origin dev');
  ok(`pushed to origin/dev — Promote workflow should kick off shortly`);
}

// ───────────── step 5: wait for Promote PR + tag main ─────────────

async function waitAndTag() {
  if (!which('gh')) {
    warn('`gh` CLI not found — skipping auto-tag.');
    printManualFinish();
    return;
  }

  info('waiting for the Promote PR (head: dev → base: main) to merge...');
  info('press Ctrl-C if you want to handle main / tag manually.');

  const startedAt = Date.now();
  const TIMEOUT_MS = 30 * 60 * 1000;   // 30 min hard cap
  const POLL_MS = 15 * 1000;

  let prNumber = null;
  while (Date.now() - startedAt < TIMEOUT_MS) {
    if (!prNumber) {
      try {
        const list = shCapture(`gh pr list --base main --head dev --state all --json number,mergedAt,state --limit 5`);
        const prs = JSON.parse(list);
        // Pick the newest one that's open or merged after we pushed.
        const fresh = prs.find(p => p.state === 'OPEN' || (p.mergedAt && Date.parse(p.mergedAt) > startedAt - 2 * POLL_MS));
        if (fresh) {
          prNumber = fresh.number;
          info(`tracking PR #${prNumber}`);
        }
      } catch (e) {
        warn(`gh pr list failed: ${e.message}`);
      }
    }

    if (prNumber) {
      try {
        const view = shCapture(`gh pr view ${prNumber} --json state,mergedAt`);
        const pr = JSON.parse(view);
        if (pr.state === 'MERGED') {
          ok(`PR #${prNumber} merged at ${pr.mergedAt}`);
          break;
        }
        if (pr.state === 'CLOSED') {
          console.error(`PR #${prNumber} was closed without merging — aborting tag step.`);
          process.exit(1);
        }
      } catch (e) {
        warn(`gh pr view failed: ${e.message}`);
      }
    }

    await new Promise(r => setTimeout(r, POLL_MS));
  }

  if (Date.now() - startedAt >= TIMEOUT_MS) {
    warn('30-minute timeout reached without seeing the PR merge.');
    printManualFinish();
    return;
  }

  syncMain();

  // Sanity: package.json on main matches version
  const mainPkg = JSON.parse(await readFile(path.join(repoRoot, 'package.json'), 'utf-8'));
  if (mainPkg.version !== version) {
    warn(`main package.json is ${mainPkg.version} but you asked for ${version}.`);
    warn('Tagging anyway, but the release artifact name may not match.');
  }

  if (dryRun) {
    info(`would tag ${tag} and push origin ${tag}`);
  } else {
    const exists = spawnSync('git', ['rev-parse', '-q', '--verify', `refs/tags/${tag}`], {
      cwd: repoRoot,
      stdio: 'ignore',
    }).status === 0;
    if (exists) warn(`tag ${tag} already exists locally`);
    else sh(`git tag ${tag}`);
    shRetry(`git push origin ${tag}`);
    ok(`tagged and pushed ${tag} — release workflow will pick it up`);
  }

  // Hop back to dev so the user lands where they started.
  sh('git checkout dev');
  ok('back on dev');
}

// ───────────── go ─────────────

(async () => {
  console.log(`Release pipeline → ${tag}${dryRun ? ' (dry-run)' : ''}\n`);
  preflight();
  bumpAndPushDev();

  if (noWait) {
    info('--no-wait set; not polling for PR merge.');
    printManualFinish();
    return;
  }

  await waitAndTag();
})().catch(err => {
  console.error(err.stack || err.message);
  process.exit(1);
});
