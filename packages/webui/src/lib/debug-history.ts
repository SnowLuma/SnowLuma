// debug-history — a capped, localStorage-backed ring buffer of recent action
// invocations for the tester (replay / inspect). Client-only and ephemeral by
// design: it's a debugging convenience, not a persisted record, so there is no
// backend store. Newest first.
export interface InvokeRecord {
  id: string;
  at: number;
  uin: string;
  action: string;
  params: Record<string, unknown>;
  ok: boolean;
  /** wall-clock ms, when known. */
  ms?: number;
  /** true if invoked via the streaming transport. */
  stream?: boolean;
}

const LS_KEY = 'snowluma.debug.history.v1';
const CAP = 200;

let seq = 0;

export function loadHistory(): InvokeRecord[] {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw) as InvokeRecord[];
    return Array.isArray(arr) ? arr : [];
  } catch { return []; }
}

export function pushHistory(rec: Omit<InvokeRecord, 'id'>): InvokeRecord[] {
  const full: InvokeRecord = { ...rec, id: `h-${rec.at.toString(36)}-${(seq++).toString(36)}` };
  const next = [full, ...loadHistory()].slice(0, CAP);
  try { localStorage.setItem(LS_KEY, JSON.stringify(next)); } catch { /* quota — drop silently */ }
  return next;
}

export function clearHistory(): void {
  try { localStorage.removeItem(LS_KEY); } catch { /* ignore */ }
}
