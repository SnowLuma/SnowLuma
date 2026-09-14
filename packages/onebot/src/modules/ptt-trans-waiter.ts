// Correlates an async voice-to-text result back to the fetch_ptt_text call
// that triggered it. QQ delivers the text via an Event 0x210 subType-61 push
// (decoded into a `ptt_trans_result` event), not in the request response — so
// the action registers a waiter keyed by `${selfUin}:${msgId}`, fires the
// trigger request, and the push subscription resolves the waiter by msgId.

interface Pending {
  resolve: (text: string) => void;
  reject: (err: Error) => void;
  timer: ReturnType<typeof setTimeout>;
}

const pending = new Map<string, Pending>();

export function pttTransKey(selfUin: number, msgId: number): string {
  return `${selfUin}:${msgId}`;
}

/**
 * Register a waiter for `key`'s transcription. Rejects after `timeoutMs`.
 * A new waiter for the same key supersedes (rejects) the previous one.
 */
export function waitPttTransText(key: string, timeoutMs: number): Promise<string> {
  const existing = pending.get(key);
  if (existing) {
    clearTimeout(existing.timer);
    pending.delete(key);
    existing.reject(new Error('语音转文字请求被新的请求取代'));
  }
  return new Promise<string>((resolve, reject) => {
    const timer = setTimeout(() => {
      if (pending.get(key)?.timer === timer) pending.delete(key);
      reject(new Error('语音转文字超时（未收到结果推送）'));
    }, timeoutMs);
    timer.unref?.();
    pending.set(key, { resolve, reject, timer });
  });
}

/** Resolve a waiting fetch_ptt_text with the recognised text. No-op if none. */
export function deliverPttTransText(key: string, text: string): void {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(key);
  p.resolve(text);
}

/** Reject a waiter (e.g. the trigger request itself failed). No-op if none. */
export function failPttTransWaiter(key: string, err: Error): void {
  const p = pending.get(key);
  if (!p) return;
  clearTimeout(p.timer);
  pending.delete(key);
  p.reject(err);
}
