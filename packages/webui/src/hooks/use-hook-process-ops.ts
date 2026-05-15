import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useApi, type ProcessActionResult } from '@/lib/api';

export type HookProcessOpKind = 'load' | 'unload' | 'refresh';

export interface HookProcessOps {
  /** Returns the in-flight op kind for a pid, or null if idle. */
  statusOf(pid: number): HookProcessOpKind | null;
  /** Latest user-facing status; auto-clears a few seconds after the last update. */
  banner: string;
  load(pid: number): Promise<void>;
  unload(pid: number): Promise<void>;
  refresh(pid: number): Promise<void>;
}

export interface UnloadFailedAlert {
  pid: number;
  error: string;
}

export interface UseHookProcessOpsResult {
  ops: HookProcessOps;
  unloadFailedAlert: UnloadFailedAlert | null;
  dismissUnloadFailedAlert: () => void;
}

interface KindMessages {
  start(pid: number): string;
  ok(pid: number): string;
  fail(message: string): string;
}

const KIND_MESSAGES: Record<HookProcessOpKind, KindMessages> = {
  load: {
    start: (pid) => `正在向进程 ${pid} 加载 SnowLuma…`,
    ok: (pid) => `已向进程 ${pid} 注入 SnowLuma，等待管道连接…`,
    fail: (m) => `加载失败：${m}`,
  },
  unload: {
    start: (pid) => `正在从进程 ${pid} 卸载…`,
    ok: (pid) => `已从进程 ${pid} 卸载`,
    fail: (m) => `卸载失败：${m}`,
  },
  refresh: {
    start: (pid) => `正在刷新进程 ${pid} 的管道状态…`,
    ok: (pid) => `已刷新进程 ${pid} 的管道状态`,
    fail: (m) => `刷新失败：${m}`,
  },
};

const BANNER_CLEAR_MS = 4000;

/**
 * Drives load/unload/refresh actions on Hook-target processes. Owns the
 * per-pid inflight dedup, the per-kind status indicator, the banner message
 * lifecycle, and the "unload silently failed" alert that surfaces when the
 * backend reports the named pipe is still alive after an unload attempt.
 */
export function useHookProcessOps(
  opts: { onAfterOp?: () => Promise<void> | void } = {},
): UseHookProcessOpsResult {
  const api = useApi();
  const [byPid, setByPid] = useState<Map<number, HookProcessOpKind>>(() => new Map());
  const [banner, setBanner] = useState('');
  const [unloadFailedAlert, setUnloadFailedAlert] = useState<UnloadFailedAlert | null>(null);

  // Synchronous inflight guard — protects against rapid double-clicks that
  // would race the byPid setter (state updates are batched, refs are not).
  const inflightRef = useRef<Set<number>>(new Set());
  const bannerTimerRef = useRef<number | null>(null);
  const onAfterOpRef = useRef(opts.onAfterOp);
  onAfterOpRef.current = opts.onAfterOp;

  useEffect(
    () => () => {
      if (bannerTimerRef.current != null) window.clearTimeout(bannerTimerRef.current);
    },
    [],
  );

  const scheduleBannerClear = useCallback(() => {
    if (bannerTimerRef.current != null) window.clearTimeout(bannerTimerRef.current);
    bannerTimerRef.current = window.setTimeout(() => {
      setBanner('');
      bannerTimerRef.current = null;
    }, BANNER_CLEAR_MS);
  }, []);

  const setKind = useCallback((pid: number, kind: HookProcessOpKind | null) => {
    setByPid((prev) => {
      const next = new Map(prev);
      if (kind == null) next.delete(pid);
      else next.set(pid, kind);
      return next;
    });
  }, []);

  const run = useCallback(
    async (
      pid: number,
      kind: HookProcessOpKind,
      action: () => Promise<ProcessActionResult>,
    ) => {
      if (inflightRef.current.has(pid)) return;
      inflightRef.current.add(pid);
      setKind(pid, kind);
      const messages = KIND_MESSAGES[kind];
      setBanner(messages.start(pid));
      try {
        const result = await action();
        if (kind === 'unload' && result.process?.status === 'connecting' && result.process.error) {
          setUnloadFailedAlert({ pid, error: result.process.error });
          setBanner(`进程 ${pid} 卸载失败`);
        } else {
          setBanner(messages.ok(pid));
        }
        await onAfterOpRef.current?.();
      } catch (e) {
        const msg = e instanceof Error ? e.message : '未知错误';
        setBanner(messages.fail(msg));
      } finally {
        inflightRef.current.delete(pid);
        setKind(pid, null);
        scheduleBannerClear();
      }
    },
    [setKind, scheduleBannerClear],
  );

  const load = useCallback(
    (pid: number) => run(pid, 'load', () => api.processes.load(pid)),
    [api, run],
  );
  const unload = useCallback(
    (pid: number) => run(pid, 'unload', () => api.processes.unload(pid)),
    [api, run],
  );
  const refresh = useCallback(
    (pid: number) => run(pid, 'refresh', () => api.processes.refresh(pid)),
    [api, run],
  );

  const statusOf = useCallback(
    (pid: number): HookProcessOpKind | null => byPid.get(pid) ?? null,
    [byPid],
  );

  const dismissUnloadFailedAlert = useCallback(() => setUnloadFailedAlert(null), []);

  const ops = useMemo<HookProcessOps>(
    () => ({ statusOf, banner, load, unload, refresh }),
    [statusOf, banner, load, unload, refresh],
  );

  return { ops, unloadFailedAlert, dismissUnloadFailedAlert };
}
