// Isolated retained-heap measurements; no QQ session, disk logs or live requests.
// node --expose-gc tools/bench-common-memory.mjs logs|colored-logs|cache [source-directory]
// The optional directory contains log-sanitize.ts and single-flight-cache.ts,
// allowing the same workload to run against sources from a baseline revision.
import { performance } from 'node:perf_hooks';
import { setImmediate, setTimeout } from 'node:timers/promises';
import { resolve } from 'node:path';
import { pathToFileURL } from 'node:url';

if (!global.gc) {
  throw new Error('Run with node --expose-gc');
}

const mode = process.argv[2] ?? 'logs';
const source = (name) =>
  process.argv[3]
    ? pathToFileURL(resolve(process.argv[3], name))
    : new URL(`../packages/common/src/${name}`, import.meta.url);

async function heapUsed() {
  await setImmediate();
  global.gc();
  global.gc();
  return process.memoryUsage().heapUsed;
}

const mib = (bytes) => Number((bytes / 1024 / 1024).toFixed(2));

if (mode === 'logs' || mode === 'colored-logs') {
  const { sanitizeLogLine } = await import(source('log-sanitize.ts'));
  const before = await heapUsed();
  const records = [];
  const started = performance.now();

  for (let i = 0; i < 1000; i += 1) {
    const body = `${i}: ${'0123456789abcdef'.repeat(512)}`;
    const line = mode === 'colored-logs' ? `\x1b[32m${body}\x1b[0m` : body;
    records.push(sanitizeLogLine(line));
  }

  const elapsedMs = Number((performance.now() - started).toFixed(1));
  const retainedHeapMiB = mib((await heapUsed()) - before);
  console.log(JSON.stringify({ mode, records: records.length, retainedHeapMiB, elapsedMs }));
} else if (mode === 'cache') {
  const { createSingleFlightCache } = await import(source('single-flight-cache.ts'));
  const ttlMs = 2000;
  const cache = createSingleFlightCache({
    ttlMs,
    load: async (key) =>
      Array.from({ length: 1000 }, (_, i) => ({
        uin: key * 1000 + i,
        nickname: `member-${key}-${i}`,
      })),
  });
  const before = await heapUsed();

  for (let key = 0; key < 500; key += 1) {
    await cache.get(key);
  }

  const populatedHeapMiB = mib((await heapUsed()) - before);
  await setTimeout(ttlMs + 100);
  const idleHeapMiB = mib((await heapUsed()) - before);
  // Keep the cache itself live through both samples, as it is in ContactsApi.
  cache.clear();
  console.log(
    JSON.stringify({
      mode,
      rosters: 500,
      membersPerRoster: 1000,
      ttlMs,
      populatedHeapMiB,
      idleHeapMiB,
    }),
  );
} else {
  throw new Error(`Unknown workload: ${mode}`);
}
