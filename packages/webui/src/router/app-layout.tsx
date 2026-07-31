import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useApi } from '@/lib/api';
import { useHookProcessOps } from '@/hooks/use-hook-process-ops';
import { MainLayout } from '@/components/layout/main-layout';
import { NAV_ITEMS } from '@/components/layout/sidebar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { AppStateProvider, type AppResourceState } from '@/contexts/AppStateContext';
import { KioskProvider } from '@/contexts/KioskContext';
import { LayoutProvider, useLayout } from '@/contexts/LayoutContext';
import { useSession } from '@/contexts/SessionContext';
import type { AppPath } from '@/router';
import type { AccountConnections, HookProcessInfo, QQInfo, SystemInfo, UpdateInfo } from '@/types';

function createInitialResources(): AppResourceState {
  return {
    qqList: { ready: false, error: null },
    processList: { ready: false, error: null },
    systemInfo: { ready: false, error: null },
    connections: { ready: false, error: null },
    updateInfo: { ready: false, error: null },
  };
}

type AppResourceKey = keyof AppResourceState;

function createResourceCounters(): Record<AppResourceKey, number> {
  return {
    qqList: 0,
    processList: 0,
    systemInfo: 0,
    connections: 0,
    updateInfo: 0,
  };
}

interface ResourceRequestTicket {
  generation: number;
  streamRevision: number;
}

function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error && error.message ? error.message : fallback;
}

/**
 * Redirects to the operator's configured landing page once (after the layout
 * config loads), but only when arriving at the root and the target is a real,
 * non-root nav route — so deep-links and later navigation are respected.
 * Rendered INSIDE LayoutProvider (needs useLayout).
 */
function DefaultRouteRedirect() {
  const { pages, ready } = useLayout();
  const navigate = useNavigate();
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const done = useRef(false);

  useEffect(() => {
    if (!ready || done.current) return;
    done.current = true;
    const target = pages.defaultRoute;
    if (target && target !== '/' && pathname === '/' && NAV_ITEMS.some((n) => n.to === target)) {
      void navigate({ to: target as AppPath });
    }
  }, [ready, pages.defaultRoute, pathname, navigate]);

  return null;
}

/**
 * The layout route. Owns the live state shared across the four pages
 * (polling lists, processOps, selectedUin) and renders `<Outlet />` inside
 * the chrome. The unload-failed alert sits here so it survives navigation
 * away from the overview page.
 */
export function AppLayout() {
  const api = useApi();
  const { pollInterval, reloadAppearance } = useTheme();
  const session = useSession();

  // Now that we're authed, re-fetch appearance from /api/ui so the
  // authed-only `customCss` (stripped from the pre-auth public subset) loads.
  useEffect(() => { void reloadAppearance(); }, [reloadAppearance]);

  const [qqList, setQqList] = useState<QQInfo[]>([]);
  const [processList, setProcessList] = useState<HookProcessInfo[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);
  const [connections, setConnections] = useState<AccountConnections[]>([]);
  const [updateInfo, setUpdateInfo] = useState<UpdateInfo | null>(null);
  const [resources, setResources] = useState<AppResourceState>(createInitialResources);
  const [selectedUin, setSelectedUin] = useState<string | null>(null);
  const requestGenerationRef = useRef(createResourceCounters());
  const streamRevisionRef = useRef(createResourceCounters());

  const settleResource = useCallback((
    resource: AppResourceKey,
    error: string | null,
  ) => {
    setResources((current) => ({
      ...current,
      [resource]: { ready: true, error },
    }));
  }, []);

  const beginResourceRequest = useCallback((resource: AppResourceKey): ResourceRequestTicket => ({
    generation: ++requestGenerationRef.current[resource],
    streamRevision: streamRevisionRef.current[resource],
  }), []);

  const isCurrentResourceRequest = useCallback((
    resource: AppResourceKey,
    ticket: ResourceRequestTicket,
  ): boolean => (
    requestGenerationRef.current[resource] === ticket.generation
    && streamRevisionRef.current[resource] === ticket.streamRevision
  ), []);

  const settleStreamResource = useCallback((resource: AppResourceKey) => {
    streamRevisionRef.current[resource] += 1;
    settleResource(resource, null);
  }, [settleResource]);

  const refreshQqList = useCallback(async () => {
    const ticket = beginResourceRequest('qqList');
    try {
      const next = await api.qqList();
      if (!isCurrentResourceRequest('qqList', ticket)) return;
      setQqList(next);
      settleResource('qqList', null);
    } catch (e) {
      if (!isCurrentResourceRequest('qqList', ticket)) {
        console.warn('ignored stale qq-list request failure', e);
        return;
      }
      console.error('qq-list', e);
      settleResource('qqList', errorMessage(e, '加载账号列表失败'));
    }
  }, [api, beginResourceRequest, isCurrentResourceRequest, settleResource]);

  const refreshProcesses = useCallback(async () => {
    const ticket = beginResourceRequest('processList');
    try {
      const next = await api.processes.list();
      if (!isCurrentResourceRequest('processList', ticket)) return;
      setProcessList(next);
      settleResource('processList', null);
    } catch (e) {
      if (!isCurrentResourceRequest('processList', ticket)) {
        console.warn('ignored stale process-list request failure', e);
        return;
      }
      console.error('processes', e);
      settleResource('processList', errorMessage(e, '加载进程列表失败'));
    }
  }, [api, beginResourceRequest, isCurrentResourceRequest, settleResource]);

  const refreshSystem = useCallback(async () => {
    const ticket = beginResourceRequest('systemInfo');
    try {
      const next = await api.system();
      if (!isCurrentResourceRequest('systemInfo', ticket)) return;
      setSystemInfo(next);
      settleResource('systemInfo', null);
    } catch (e) {
      if (!isCurrentResourceRequest('systemInfo', ticket)) {
        console.warn('ignored stale system-info request failure', e);
        return;
      }
      console.error('system', e);
      settleResource('systemInfo', errorMessage(e, '加载系统信息失败'));
    }
  }, [api, beginResourceRequest, isCurrentResourceRequest, settleResource]);

  const refreshConnections = useCallback(async () => {
    const ticket = beginResourceRequest('connections');
    try {
      const next = await api.connections();
      if (!isCurrentResourceRequest('connections', ticket)) return;
      setConnections(next);
      settleResource('connections', null);
    } catch (e) {
      if (!isCurrentResourceRequest('connections', ticket)) {
        console.warn('ignored stale connections request failure', e);
        return;
      }
      console.error('connections', e);
      settleResource('connections', errorMessage(e, '加载连接状态失败'));
    }
  }, [api, beginResourceRequest, isCurrentResourceRequest, settleResource]);

  const refreshUpdate = useCallback(async (force = false) => {
    const ticket = beginResourceRequest('updateInfo');
    try {
      const next = await api.update.check(force);
      if (!isCurrentResourceRequest('updateInfo', ticket)) return null;
      setUpdateInfo(next);
      settleResource('updateInfo', null);
      return next;
    } catch (e) {
      if (!isCurrentResourceRequest('updateInfo', ticket)) {
        console.warn('ignored stale update-check request failure', e);
        return null;
      }
      console.error('update-check', e);
      settleResource('updateInfo', errorMessage(e, '检查更新失败'));
      if (force) throw e;
      return null;
    }
  }, [api, beginResourceRequest, isCurrentResourceRequest, settleResource]);

  const { ops: processOps, unloadFailedAlert, dismissUnloadFailedAlert } = useHookProcessOps({
    onAfterOp: refreshProcesses,
  });

  // Primary live-state path: subscribe to /api/state/stream and apply
  // pushed snapshots directly. Initial frames on connect prime
  // processes/qqList/connections without a polling tick.
  //
  // On `{kind:'dropped'}` (backpressure made the server skip some frames),
  // a per-resource SSE auto-recovery is NOT guaranteed: the next delivered
  // frame is whatever resource next changes, not necessarily the one whose
  // update we lost. So on dropped, kick a one-shot REST reconcile to
  // recover immediately instead of waiting up to 30s for the fallback.
  useEffect(() => {
    const dispose = api.stateStream({
      onEvent: (event) => {
        if ('resource' in event) {
          if (event.resource === 'processes') {
            setProcessList(event.data);
            settleStreamResource('processList');
          } else if (event.resource === 'qq-list') {
            setQqList(event.data);
            settleStreamResource('qqList');
          } else if (event.resource === 'connections') {
            setConnections(event.data);
            settleStreamResource('connections');
          }
          return;
        }
        if ('kind' in event && event.kind === 'dropped') {
          // Fire-and-forget; each refresh has its own try/catch.
          void refreshQqList();
          void refreshProcesses();
          void refreshConnections();
        }
      },
    });
    return () => { dispose(); };
  }, [api, refreshQqList, refreshProcesses, refreshConnections, settleStreamResource]);

  // Slow reconcile fallback for the SSE-covered resources. SSE drops can
  // be silent (proxy rewrites text/event-stream, tab thrashing). One REST
  // tick per (pollInterval × 10, min 10s) recovers from those without
  // hammering the server.
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const reconcileMs = Math.max(pollInterval * 10, 10_000);
    const tick = async () => {
      // Skip while the tab is hidden — SSE already carries live updates, and a
      // backgrounded tab has no UI to refresh. Re-tick on becoming visible.
      // `running` drops a tick while the previous refresh is still in flight,
      // so a slow backend can't stack overlapping requests.
      if (cancelled || document.hidden || running) return;
      running = true;
      try {
        await Promise.all([refreshQqList(), refreshProcesses(), refreshConnections()]);
      } finally {
        running = false;
      }
    };
    // Initial tick primes the lists before the SSE handshake completes
    // (avoids a flash of empty state in the chrome).
    tick();
    const interval = pollInterval > 0 ? setInterval(tick, reconcileMs) : null;
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pollInterval, refreshQqList, refreshProcesses, refreshConnections]);

  // systemInfo has its OWN fast cadence — it carries live values (uptime,
  // cpu loadAvg, memory.usagePercent, runtime.heapUsed) that the overview
  // widget visibly animates. It isn't on the SSE feed, so a 30s reconcile
  // would visibly lag the dashboard. Keep the user's configured
  // pollInterval (default 3s) here.
  useEffect(() => {
    let cancelled = false;
    let running = false;
    const tick = async () => {
      if (cancelled || document.hidden || running) return;
      running = true;
      try { await refreshSystem(); } finally { running = false; }
    };
    tick();
    const interval = pollInterval > 0 ? setInterval(tick, pollInterval) : null;
    const onVisible = () => { if (!document.hidden) void tick(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      cancelled = true;
      if (interval !== null) clearInterval(interval);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [pollInterval, refreshSystem]);

  // Update check runs on its own slow cadence (6h), independent of the fast
  // list-polling above — GitHub's API is rate-limited, the result rarely
  // changes, and the server caches it anyway, so this is cheap.
  useEffect(() => {
    let running = false;
    const tick = async () => {
      if (running) return;
      running = true;
      try { await refreshUpdate(); } finally { running = false; }
    };
    tick();
    const id = setInterval(tick, 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshUpdate]);

  const handleLogout = useCallback(async () => {
    for (const resource of Object.keys(requestGenerationRef.current) as AppResourceKey[]) {
      requestGenerationRef.current[resource] += 1;
      streamRevisionRef.current[resource] += 1;
    }
    await api.logout();
    setQqList([]);
    setProcessList([]);
    setSystemInfo(null);
    setConnections([]);
    setUpdateInfo(null);
    setResources(createInitialResources());
    setSelectedUin(null);
    session.onLogoutComplete();
  }, [api, session]);

  const migrationNotice = useMemo(() => {
    const active = connections.filter((account) => {
      const phase = account.databaseMigration?.phase;
      return phase && phase !== 'complete';
    });
    if (active.length === 0) return null;
    const preparing = active.filter((account) => account.databaseMigration?.phase === 'preparing').length;
    const migrating = active.filter((account) => account.databaseMigration?.phase === 'migrating').length;
    const failedUsable = active.filter((account) => (
      account.databaseMigration?.phase === 'failed' && account.databaseMigration.usable
    )).length;
    const failedUnavailable = active.filter((account) => (
      account.databaseMigration?.phase === 'failed' && !account.databaseMigration.usable
    )).length;
    const parts = [
      ...(preparing > 0 ? [`${preparing} 个账号正在准备数据库，暂不可用`] : []),
      ...(migrating > 0 ? [`${migrating} 个账号正在后台迁移，功能可用`] : []),
      ...(failedUsable > 0 ? [`${failedUsable} 个可用账号迁移失败，将自动重试`] : []),
      ...(failedUnavailable > 0 ? [`${failedUnavailable} 个账号数据库准备失败，暂不可用并将自动重试`] : []),
    ];
    return (
      <div
        role="status"
        className="border-b border-warning/25 bg-warning/10 px-4 py-2.5 text-sm text-warning-foreground sm:px-6 lg:px-8"
      >
        <span className="font-medium">账号数据库状态：</span>
        {parts.join('；')}。请查看概览详情。
      </div>
    );
  }, [connections]);

  return (
    <AppStateProvider
      value={{
        qqList,
        processList,
        systemInfo,
        connections,
        updateInfo,
        resources,
        selectedUin,
        setSelectedUin,
        processOps,
        refreshQqList,
        refreshProcesses,
        refreshSystem,
        refreshConnections,
        refreshUpdate,
        onLogout: handleLogout,
      }}
    >
      <LayoutProvider>
        <KioskProvider>
          <DefaultRouteRedirect />
          <MainLayout status={session.status} onLogout={handleLogout} notice={migrationNotice}>
            {/* Routes use `lazyRouteComponent` (router/index.tsx) for
                code-splitting, which suspends until the chunk is fetched.
                The chrome (sidebar / top bar) stays mounted across this
                boundary so only the page surface flashes a skeleton. */}
            <Suspense fallback={<PageFallback />}>
              <Outlet />
            </Suspense>
          </MainLayout>
        </KioskProvider>
      </LayoutProvider>

      <ConfirmDialog
        open={!!unloadFailedAlert}
        onOpenChange={(open) => !open && dismissUnloadFailedAlert()}
        title="卸载失败"
        description={
          unloadFailedAlert ? (
            <>
              <p>进程 {unloadFailedAlert.pid} 的 SnowLuma DLL 卸载失败。</p>
              <p className="mt-2 text-sm">{unloadFailedAlert.error}</p>
              <p className="mt-2 text-sm text-muted-foreground">
                系统将继续尝试重新连接该进程。如需彻底卸载，请重启 QQ 进程。
              </p>
            </>
          ) : null
        }
        confirmText="知道了"
        onConfirm={dismissUnloadFailedAlert}
      />
    </AppStateProvider>
  );
}

function PageFallback() {
  return (
    <SkeletonSwap
      ready={false}
      lines={7}
      lineHeight={28}
      barHeight={11}
      reserve={196}
      label="页面内容"
      className="w-full"
    >
      {null}
    </SkeletonSwap>
  );
}
