import { AsyncLocalStorage } from 'async_hooks';

interface RequestStore {
  id: number;
}

const storage = new AsyncLocalStorage<RequestStore>();
let counter = 0;

/**
 * Allocate the next per-process request id (monotonic). Wraps via uint32 so
 * it never overflows to a non-integer; `0` is skipped so "no id" stays
 * unambiguous.
 */
export function nextRequestId(): number {
  counter = (counter + 1) >>> 0;
  if (counter === 0) counter = 1;
  return counter;
}

/**
 * Run `fn` with `id` bound as the ambient request id for the entire async
 * chain it spawns. Any logger call anywhere in that chain — across packages,
 * across awaits — picks it up via {@link currentRequestId} with no signature
 * threading. Used by the OneBot action handler to correlate a request's whole
 * journey (entry → outbound packets → exit) under one `[req#N]` tag.
 */
export function runWithRequestId<T>(id: number, fn: () => T): T {
  return storage.run({ id }, fn);
}

/** The request id bound to the current async context, or undefined outside one. */
export function currentRequestId(): number | undefined {
  return storage.getStore()?.id;
}
