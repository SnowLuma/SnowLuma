/**
 * Map `items` through `fn` in sequential batches of at most `concurrency`
 * items, awaiting each batch (`Promise.all`) before starting the next.
 * Results come back in input order.
 *
 * Batched, not a rolling pool: every item in a batch must settle before the
 * next batch starts. This caps peak parallelism — used to keep rate-limited
 * fan-out (e.g. the per-uin OIDB profile fetches during forward-node
 * enrichment) from bursting past a safe width and tripping Tencent
 * risk-control. Pair it with a cap on `items` (slice) and per-item error
 * handling inside `fn` for a fully bounded, best-effort enrichment — the
 * shape that was previously hand-rolled at each such call site.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.trunc(concurrency));
  const results = new Array<R>(items.length);
  for (let i = 0; i < items.length; i += limit) {
    const batch = items.slice(i, i + limit);
    const settled = await Promise.all(batch.map((item, j) => fn(item, i + j)));
    for (let j = 0; j < settled.length; j++) results[i + j] = settled[j]!;
  }
  return results;
}
