import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TooltipProvider } from '@/components/ui/tooltip';
import { ThemeProvider, useTheme } from '@/contexts/ThemeContext';
import { LoginPage } from '@/components/pages/login-page';
import { MainLayout } from '@/components/layout/main-layout';
import { OverviewPage } from '@/components/pages/overview-page';
import { ConfigPage } from '@/components/pages/config-page';
import { LogsPage } from '@/components/pages/logs-page';
import { SettingsPage } from '@/components/pages/settings-page';
import { ChangePasswordPage } from '@/components/pages/change-password-page';
import { ConfirmDialog } from '@/components/confirm-dialog';
import type { Page } from '@/components/layout/sidebar';
import type { HookProcessInfo, QQInfo, SystemInfo } from '@/types';
import { ApiProvider, createApiClient, useApi, type ApiClient } from '@/lib/api';

export default function App() {
  return (
    <ThemeProvider>
      <AuthBoundary />
    </ThemeProvider>
  );
}

function AuthBoundary() {
  const [authChecked, setAuthChecked] = useState(false);
  const [authed, setAuthed] = useState(false);
  const [mustChange, setMustChange] = useState(false);
  const [status, setStatus] = useState('未连接');

  const client = useMemo<ApiClient>(
    () =>
      createApiClient({
        onUnauthorized: () => {
          setAuthed(false);
          setStatus('未授权');
        },
      }),
    [],
  );

  useEffect(() => {
    (async () => {
      const ok = await client.status();
      if (ok) {
        setAuthed(true);
        setStatus('已连接');
        setMustChange(await client.mustChangePassword());
      }
      setAuthChecked(true);
    })();
  }, [client]);

  return (
    <ApiProvider client={client}>
      <TooltipProvider delayDuration={150}>
        {!authChecked ? (
          <div className="flex min-h-screen items-center justify-center bg-background text-sm text-muted-foreground">
            初始化中…
          </div>
        ) : !authed ? (
          <LoginGate
            onAuthed={(needsChange) => {
              setAuthed(true);
              setStatus('已连接');
              setMustChange(needsChange);
            }}
          />
        ) : mustChange ? (
          <ForcedChangePasswordGate onSuccess={() => setMustChange(false)} />
        ) : (
          <AppInner
            status={status}
            onLogoutComplete={() => {
              setAuthed(false);
              setStatus('未连接');
              setMustChange(false);
            }}
          />
        )}
      </TooltipProvider>
    </ApiProvider>
  );
}

function LoginGate({ onAuthed }: { onAuthed: (mustChange: boolean) => void }) {
  const api = useApi();
  const handleLogin = useCallback(
    async (password: string) => {
      const result = await api.login(password);
      if (!result.ok) return { success: false, error: result.message };
      onAuthed(result.mustChangePassword);
      return { success: true };
    },
    [api, onAuthed],
  );
  return <LoginPage onLogin={handleLogin} />;
}

function ForcedChangePasswordGate({ onSuccess }: { onSuccess: () => void }) {
  const api = useApi();
  return (
    <ChangePasswordPage
      forced
      checkStrength={(p) => api.checkPasswordStrength(p)}
      submit={(o, n) => api.changePassword(o, n)}
      onSuccess={onSuccess}
    />
  );
}

interface AppInnerProps {
  status: string;
  onLogoutComplete: () => void;
}

function AppInner({ status, onLogoutComplete }: AppInnerProps) {
  const api = useApi();
  const { pollInterval } = useTheme();
  const [active, setActive] = useState<Page>('overview');

  const [qqList, setQqList] = useState<QQInfo[]>([]);
  const [processList, setProcessList] = useState<HookProcessInfo[]>([]);
  const [systemInfo, setSystemInfo] = useState<SystemInfo | null>(null);

  const [processLoadingPid, setProcessLoadingPid] = useState<number | null>(null);
  const [processUnloadingPid, setProcessUnloadingPid] = useState<number | null>(null);
  const [processRefreshingPid, setProcessRefreshingPid] = useState<number | null>(null);
  const [processActionStatus, setProcessActionStatus] = useState('');
  const [unloadFailedAlert, setUnloadFailedAlert] = useState<{ pid: number; error: string } | null>(null);
  // Tracks PIDs with an in-flight load/unload/refresh request so the UI can
  // collapse spam-clicks instead of firing a second concurrent request.
  const inflightProcessOps = useRef(new Set<number>());

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

  useEffect(() => {
    if (pollInterval <= 0) return;
    let cancelled = false;
    const tick = async () => {
      if (cancelled) return;
      await Promise.all([refreshQqList(), refreshProcesses(), refreshSystem()]);
    };
    tick();
    const interval = setInterval(tick, pollInterval);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollInterval, refreshQqList, refreshProcesses, refreshSystem]);

  const handleLogout = useCallback(async () => {
    await api.logout();
    setQqList([]);
    setProcessList([]);
    setSystemInfo(null);
    onLogoutComplete();
  }, [api, onLogoutComplete]);

  const handleLoadProcess = useCallback(
    async (pid: number) => {
      if (inflightProcessOps.current.has(pid)) return;
      inflightProcessOps.current.add(pid);
      setProcessLoadingPid(pid);
      setProcessActionStatus(`正在向进程 ${pid} 加载 SnowLuma…`);
      try {
        await api.processes.load(pid);
        setProcessActionStatus(`已向进程 ${pid} 注入 SnowLuma，等待管道连接…`);
        await refreshProcesses();
      } catch (e) {
        setProcessActionStatus(`加载失败：${e instanceof Error ? e.message : '未知错误'}`);
      } finally {
        inflightProcessOps.current.delete(pid);
        setProcessLoadingPid(null);
        setTimeout(() => setProcessActionStatus(''), 4000);
      }
    },
    [api, refreshProcesses],
  );

  const handleUnloadProcess = useCallback(
    async (pid: number) => {
      if (inflightProcessOps.current.has(pid)) return;
      inflightProcessOps.current.add(pid);
      setProcessUnloadingPid(pid);
      setProcessActionStatus(`正在从进程 ${pid} 卸载…`);
      try {
        const result = await api.processes.unload(pid);
        if (result.process?.status === 'connecting' && result.process.error) {
          setUnloadFailedAlert({ pid, error: result.process.error });
          setProcessActionStatus(`进程 ${pid} 卸载失败`);
        } else {
          setProcessActionStatus(`已从进程 ${pid} 卸载`);
        }
        await refreshProcesses();
      } catch (e) {
        setProcessActionStatus(`卸载失败：${e instanceof Error ? e.message : '未知错误'}`);
      } finally {
        inflightProcessOps.current.delete(pid);
        setProcessUnloadingPid(null);
        setTimeout(() => setProcessActionStatus(''), 4000);
      }
    },
    [api, refreshProcesses],
  );

  const handleRefreshProcess = useCallback(
    async (pid: number) => {
      if (inflightProcessOps.current.has(pid)) return;
      inflightProcessOps.current.add(pid);
      setProcessRefreshingPid(pid);
      setProcessActionStatus(`正在刷新进程 ${pid} 的管道状态…`);
      try {
        await api.processes.refresh(pid);
        setProcessActionStatus(`已刷新进程 ${pid} 的管道状态`);
        await refreshProcesses();
      } catch (e) {
        setProcessActionStatus(`刷新失败：${e instanceof Error ? e.message : '未知错误'}`);
      } finally {
        inflightProcessOps.current.delete(pid);
        setProcessRefreshingPid(null);
        setTimeout(() => setProcessActionStatus(''), 4000);
      }
    },
    [api, refreshProcesses],
  );

  return (
    <>
      <MainLayout active={active} onNavigate={setActive} status={status} onLogout={handleLogout}>
        {active === 'overview' && (
          <OverviewPage
            qqList={qqList}
            status={status}
            processList={processList}
            processLoadingPid={processLoadingPid}
            processUnloadingPid={processUnloadingPid}
            processRefreshingPid={processRefreshingPid}
            processActionStatus={processActionStatus}
            systemInfo={systemInfo}
            onRefreshProcesses={refreshProcesses}
            onRefreshSystem={refreshSystem}
            onLoadProcess={handleLoadProcess}
            onUnloadProcess={handleUnloadProcess}
            onRefreshProcess={handleRefreshProcess}
          />
        )}
        {active === 'config' && <ConfigPage qqList={qqList} />}
        {active === 'logs' && <LogsPage />}
        {active === 'settings' && <SettingsPage onLogout={handleLogout} />}
      </MainLayout>

      <ConfirmDialog
        open={!!unloadFailedAlert}
        onOpenChange={(open) => !open && setUnloadFailedAlert(null)}
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
        onConfirm={() => setUnloadFailedAlert(null)}
      />
    </>
  );
}
