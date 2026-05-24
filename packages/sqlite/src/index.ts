import BetterSqlite3 from 'better-sqlite3';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

// Re-export the public types/classes consumers need. `Database` and
// `Statement` come straight from better-sqlite3 — we only intercept
// the constructor at call time, not the class shape.
export type { Database, Options, RunResult, Statement } from 'better-sqlite3';

function triplet(): string {
  return `${process.platform}-${process.arch}`;
}

function abi(): string {
  // `process.versions.modules` is the NODE_MODULE_VERSION the running
  // Node binary expects — e.g. "127" for Node 22, "137" for Node 24.
  // Stays in sync with whatever the host actually does at load time.
  return `v${process.versions.modules}`;
}

function locateBinding(): string {
  const tri = triplet();
  const fileName = `better-sqlite3-${abi()}-${tri}.node`;
  // Two candidate locations, tried in order:
  //   1. Production: dist/native/better-sqlite3-<triplet>.node
  //      — `import.meta.url` resolves to dist/ at runtime (the wrapper
  //      is bundled into index.mjs alongside it).
  //   2. Dev:        <repo>/packages/runtime/native/better-sqlite3-<triplet>.node
  //      — `import.meta.url` resolves to packages/sqlite/src/index.ts;
  //      walk up to repo root + into runtime/native.
  const here = dirname(fileURLToPath(import.meta.url));
  const distCandidate = join(here, 'native', fileName);
  if (existsSync(distCandidate)) return distCandidate;

  // From packages/sqlite/src ⇢ go up to packages/, then into
  // runtime/native. (Two `..` segments, not three — `src` → `sqlite/`
  // → `packages/`, then descend into `runtime/native`.)
  const devCandidate = resolve(here, '..', '..', 'runtime', 'native', fileName);
  if (existsSync(devCandidate)) return devCandidate;

  throw new Error(
    `@snowluma/sqlite: could not locate ${fileName}. ` +
    `Tried:\n  ${distCandidate}\n  ${devCandidate}\n` +
    `Run \`node tools/fetch-sqlite-prebuilts.mjs\` to vendor the missing platform binary.`,
  );
}

// Load the native addon once at module import — keeping it module-
// scoped so the require() cost is paid exactly once per process.
let addon: unknown | null = null;
function loadAddon(): unknown {
  if (addon) return addon;
  const bindingPath = locateBinding();
  // better-sqlite3 expects the addon to be loaded via the CJS
  // require() mechanism (N-API init runs through it). createRequire
  // is the ESM-safe way to do that with an absolute path.
  const req = createRequire(import.meta.url);
  addon = req(bindingPath);
  return addon;
}

// Drop-in `Database` factory. Matches the better-sqlite3 default-
// export signature exactly: `new Database(filename[, options])` →
// `Database` instance.
//
// We can't just `class extends BetterSqlite3` because better-sqlite3's
// default export is a function that returns the instance (the `new
// Database(...)` shape works through that function's `new.target`
// check). Wrapping at the function-call boundary keeps that contract
// intact.
type BetterSqlite3Type = typeof BetterSqlite3;
type DatabaseInstance = InstanceType<BetterSqlite3Type>;
type DatabaseOptions = ConstructorParameters<BetterSqlite3Type>[1];

const Database = function Database(filename?: string | Buffer, options?: DatabaseOptions): DatabaseInstance {
  const opts = { ...(options ?? {}), nativeBinding: loadAddon() } as DatabaseOptions;
  // The `as any` shrug here is unavoidable — better-sqlite3's
  // overload set declares `new Database(...)` returns the class type
  // but its default export is a callable that *also* returns it via
  // an internal `new.target == null` branch. TS can't reconcile the
  // two without `as any`.

  return new (BetterSqlite3 as any)(filename, opts);
} as unknown as BetterSqlite3Type;

export default Database;
