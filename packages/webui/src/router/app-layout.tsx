import { Suspense, useCallback, useEffect, useRef, useState } from 'react';
import { Outlet, useNavigate, useRouterState } from '@tanstack/react-router';
import { useTheme } from '@/contexts/ThemeContext';
import { useApi } from '@/lib/api';
import { useHookProcessOps } from '@/hooks/use-hook-process-ops';
import { MainLayout } from '@/components/layout/main-layout';
import { NAV_ITEMS } from '@/components/layout/sidebar';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { Skeleton } from '@/components/ui/skeleton';
import { AppStateProvider } from '@/contexts/AppStateContext';
import { LayoutProvider, useLayout } from '@/contexts/LayoutContext';
import { useSession } from '@/contexts/SessionContext';
import type { AppPath } from '@/router';
import type { AccountConnections, HookProcessInfo, QQInfo, SystemInfo, UpdateInfo } from '@/types';

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
  const [selectedUin, setSelectedUin] = useState<string | null>(null);

  const refreshQqList = useCallback(async () => {
    try {
      setQqList(await api.qqList());
    } catch (e) {
      console.error('qq-list', e);
    }
  }, [api]);

  const refreshProcesses = useCallback(async () => {
    try {
      setProcessList(await api.processes.list());
    } catch (e) {
      console.error('processes', e);
    }
  }, [api]);

  const refreshSystem = useCallback(async () => {
    try {
      setSystemInfo(await api.system());
    } catch (e) {
      console.error('system', e);
    }
  }, [api]);

  const refreshConnections = useCallback(async () => {
    try {
      setConnections(await api.connections());
    } catch (e) {
      console.error('connections', e);
    }
  }, [api]);

  const refreshUpdate = useCallback(async (force = false) => {
    try {
      setUpdateInfo(await api.update.check(force));
    } catch (e) {
      console.error('update-check', e);
    }
  }, [api]);

  const { ops: processOps, unloadFailedAlert, dismissUnloadFailedAlert } = useHookProcessOps({
    onAfterOp: refreshProcesses,
  });

  useEffect(() => {
    if (pollInterval <= 0) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshQqList(), refreshProcesses(), refreshSystem(), refreshConnections()]);
    };
    tick();
    const interval = setInterval(tick, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollInterval, refreshQqList, refreshProcesses, refreshSystem, refreshConnections]);

  // Update check runs on its own slow cadence (6h), independent of the fast
  // list-polling above — GitHub's API is rate-limited, the result rarely
  // changes, and the server caches it anyway, so this is cheap.
  useEffect(() => {
    refreshUpdate();
    const id = setInterval(() => refreshUpdate(), 6 * 60 * 60 * 1000);
    return () => clearInterval(id);
  }, [refreshUpdate]);

  const handleLogout = useCallback(async () => {
    await api.logout();
    setQqList([]);
    setProcessList([]);
    setSystemInfo(null);
    setConnections([]);
    setUpdateInfo(null);
    setSelectedUin(null);
    session.onLogoutComplete();
  }, [api, session]);

  return (
    <AppStateProvider
      value={{
        qqList,
        processList,
        systemInfo,
        connections,
        updateInfo,
        selectedUin,
        setSelectedUin,
        processOps,
        refreshProcesses,
        refreshSystem,
        refreshConnections,
        refreshUpdate,
        onLogout: handleLogout,
      }}
    >
      <LayoutProvider>
        <DefaultRouteRedirect />
        <MainLayout status={session.status} onLogout={handleLogout}>
          {/* Routes use `lazyRouteComponent` (router/index.tsx) for
              code-splitting, which suspends until the chunk is fetched.
              The chrome (sidebar / top bar) stays mounted across this
              boundary so only the page surface flashes a skeleton. */}
          <Suspense fallback={<PageFallback />}>
            <Outlet />
          </Suspense>
        </MainLayout>
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
  // Generic page placeholder. Kept intentionally low-detail (just a
  // header + a couple of card-shaped blocks) so it works for every
  // route — overview's stat grid, config's tabbed editor, logs' list,
  // and the settings page all converge on roughly this skeleton on
  // their own loading states.
  return (
    <div className="flex flex-col gap-4">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-10" />
      <Skeleton className="h-32" />
      <Skeleton className="h-32" />
    </div>
  );
}
