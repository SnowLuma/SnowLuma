// DebugTaskContext — an app-level registry of in-flight debug-console tasks
// (file uploads, streaming invocations) so they survive tab/page switches
// WITHIN the app (their state lives above the page, not in the unmounting tab).
// A full page unload (refresh / close) can't be survived, so a beforeunload
// guard warns while any task runs. Finished tasks linger briefly for history.
import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';

export type DebugTaskStatus = 'running' | 'done' | 'failed' | 'canceled';
export type DebugTaskKind = 'upload' | 'stream' | 'invoke';

export interface DebugTask {
  id: string;
  kind: DebugTaskKind;
  label: string;
  status: DebugTaskStatus;
  /** 0..1 when determinate; undefined = indeterminate. */
  progress?: number;
  detail?: string;
  startedAt: number;
  endedAt?: number;
  /** Cancel the underlying work (abort the fetch / xhr). */
  cancel?: () => void;
}

interface DebugTaskContextValue {
  tasks: DebugTask[];
  /** Register a task; returns its id. */
  start: (task: Omit<DebugTask, 'id' | 'status' | 'startedAt'> & { id?: string }) => string;
  update: (id: string, patch: Partial<Omit<DebugTask, 'id'>>) => void;
  /** Mark terminal (done/failed/canceled) and stamp endedAt. */
  finish: (id: string, status: Exclude<DebugTaskStatus, 'running'>, detail?: string) => void;
  remove: (id: string) => void;
  clearFinished: () => void;
}

const Ctx = createContext<DebugTaskContextValue | null>(null);

let seq = 0;
const nextId = () => `dt-${Date.now().toString(36)}-${(seq++).toString(36)}`;

export function DebugTaskProvider({ children }: { children: ReactNode }) {
  const [tasks, setTasks] = useState<DebugTask[]>([]);

  const start = useCallback<DebugTaskContextValue['start']>((t) => {
    const id = t.id ?? nextId();
    setTasks((prev) => {
      const next = [{ ...t, id, status: 'running' as const, startedAt: Date.now() }, ...prev];
      if (next.length <= 50) return next;
      // Over cap: evict the OLDEST finished tasks only — never drop a running
      // task (that would orphan its finish()/cancel handle while it keeps going).
      const running = next.filter((x) => x.status === 'running').length;
      const finished = next.filter((x) => x.status !== 'running');
      const drop = new Set(finished.slice(Math.max(0, 50 - running)).map((x) => x.id));
      return next.filter((x) => !drop.has(x.id));
    });
    return id;
  }, []);

  const update = useCallback<DebugTaskContextValue['update']>((id, patch) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, ...patch } : t)));
  }, []);

  const finish = useCallback<DebugTaskContextValue['finish']>((id, status, detail) => {
    setTasks((prev) => prev.map((t) => (t.id === id ? { ...t, status, detail: detail ?? t.detail, endedAt: Date.now(), cancel: undefined } : t)));
  }, []);

  const remove = useCallback<DebugTaskContextValue['remove']>((id) => {
    setTasks((prev) => prev.filter((t) => t.id !== id));
  }, []);

  const clearFinished = useCallback(() => {
    setTasks((prev) => prev.filter((t) => t.status === 'running'));
  }, []);

  // beforeunload guard: a real page unload kills in-flight tasks, so warn while
  // any task is still running (within-app navigation is safe — state is here).
  useEffect(() => {
    const anyRunning = tasks.some((t) => t.status === 'running');
    if (!anyRunning) return;
    const handler = (e: BeforeUnloadEvent) => { e.preventDefault(); e.returnValue = ''; };
    window.addEventListener('beforeunload', handler);
    return () => window.removeEventListener('beforeunload', handler);
  }, [tasks]);

  const value = useMemo<DebugTaskContextValue>(
    () => ({ tasks, start, update, finish, remove, clearFinished }),
    [tasks, start, update, finish, remove, clearFinished],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useDebugTasks(): DebugTaskContextValue {
  const v = useContext(Ctx);
  if (!v) throw new Error('useDebugTasks must be used within DebugTaskProvider');
  return v;
}

/** Convenience: count + aggregate progress of running tasks, for the badge. */
export function useRunningTaskSummary(): { count: number; progress: number | null } {
  const { tasks } = useDebugTasks();
  return useMemo(() => {
    const running = tasks.filter((t) => t.status === 'running');
    if (running.length === 0) return { count: 0, progress: null };
    const determinate = running.filter((t) => typeof t.progress === 'number');
    const progress = determinate.length
      ? determinate.reduce((s, t) => s + (t.progress ?? 0), 0) / determinate.length
      : null;
    return { count: running.length, progress };
  }, [tasks]);
}
