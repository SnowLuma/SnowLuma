import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { AlertCircle, CheckCircle2, Cpu, Eye, Loader2, RefreshCw, Unplug } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { ProcessProbeDialog } from '@/components/process-probe-dialog';
import { cn } from '@/lib/utils';
import type { HookProcessInfo } from '@/types';
import { useAppState } from '@/contexts/AppStateContext';
import { useLayout } from '@/contexts/LayoutContext';
import { useTheme } from '@/contexts/ThemeContext';

const SORT_OPTIONS: { id: string; label: string }[] = [
  { id: 'pid', label: 'PID' },
  { id: 'name', label: '名称' },
  { id: 'status', label: '状态' },
];
// Online-first, then by how actionable the state is.
const STATUS_ORDER: Record<HookProcessInfo['status'], number> = {
  online: 0, loaded: 1, connecting: 2, loading: 3, available: 4, disconnected: 5, error: 6,
};

const processStatusLabel: Record<HookProcessInfo['status'], string> = {
  available: '可加载',
  loading: '加载中',
  connecting: '等待连接',
  loaded: '等待登录',
  online: '已在线',
  error: '错误',
  disconnected: '已断开',
};

function processBadgeVariant(status: HookProcessInfo['status']) {
  if (status === 'online') return 'success' as const;
  if (status === 'error') return 'destructive' as const;
  if (status === 'disconnected') return 'destructive' as const;
  if (status === 'loading' || status === 'connecting' || status === 'loaded') return 'default' as const;
  return 'secondary' as const;
}

/**
 * Process / injection control surface. Split out of the overview page so the
 * homepage stays a read-only monitoring dashboard. State (processList,
 * processOps) is owned by AppLayout and read from context, so this page needs
 * no plumbing of its own; the layout keeps polling and the unload-failed alert
 * regardless of which page is mounted.
 */
export function ProcessesPage() {
  const { processList, processOps, refreshProcesses } = useAppState();
  const { statusOf, banner: processActionStatus, load, unload, refresh } = processOps;
  const { pages, setPages } = useLayout();
  const off = useTheme().appearance.disableMotion;
  const [confirm, setConfirm] = useState<{ kind: 'load' | 'unload'; pid: number; name: string } | null>(null);
  const [probeDialog, setProbeDialog] = useState<{ pid: number; name: string } | null>(null);

  const sortKey = pages.processesSort;
  const sorted = useMemo(() => {
    const arr = [...processList];
    if (sortKey === 'name') arr.sort((a, b) => (a.name || '').localeCompare(b.name || ''));
    else if (sortKey === 'status') arr.sort((a, b) => (STATUS_ORDER[a.status] ?? 9) - (STATUS_ORDER[b.status] ?? 9) || a.pid - b.pid);
    else arr.sort((a, b) => a.pid - b.pid);
    return arr;
  }, [processList, sortKey]);

  return (
    <div className="flex flex-col gap-6">
      <Card>
        <CardHeader className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between sm:space-y-0">
          <div className="min-w-0">
            <CardTitle>进程注入</CardTitle>
            <CardDescription>加载 SnowLuma 后会监听登录状态，登录后自动接入 OneBot 流程</CardDescription>
          </div>
          <div className="flex items-center gap-2">
            {processList.length > 1 && (
              <div className="hidden items-center gap-1 rounded-lg bg-muted/60 p-1 sm:flex" role="radiogroup" aria-label="排序方式">
                {SORT_OPTIONS.map((o) => {
                  const active = sortKey === o.id;
                  return (
                    <button
                      key={o.id}
                      type="button"
                      role="radio"
                      aria-checked={active}
                      onClick={() => setPages({ processesSort: o.id })}
                      className={cn(
                        'rounded-md px-2.5 py-1 text-[11px] font-medium transition-all cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
                        active ? 'bg-card font-semibold text-foreground shadow-sm ring-1 ring-border' : 'text-muted-foreground hover:text-foreground',
                      )}
                    >
                      {o.label}
                    </button>
                  );
                })}
              </div>
            )}
            <Button variant="outline" size="sm" onClick={refreshProcesses}>
              <RefreshCw className="size-3.5" /> 刷新
            </Button>
          </div>
        </CardHeader>
        <CardContent>
          {processActionStatus && (
            <motion.div
              initial={off ? false : { opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-3 flex items-center gap-2 rounded-lg border border-primary/20 bg-primary/[0.06] px-3 py-2 text-xs text-primary"
            >
              <Loader2 className="size-3.5 shrink-0 animate-spin" />
              {processActionStatus}
            </motion.div>
          )}
          {processList.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-16 text-muted-foreground">
              <Cpu className="size-8 opacity-40" strokeWidth={1.5} />
              <p className="text-sm">未检测到可加载 QQ 主进程</p>
              <p className="text-[11px] text-muted-foreground/80">请确认 QQ 已启动后点击右上角刷新</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2 2xl:grid-cols-3">
              {sorted.map((proc, idx) => {
                const op = statusOf(proc.pid);
                const loading = op === 'load' || proc.status === 'loading';
                const unloading = op === 'unload';
                const refreshing = op === 'refresh';
                const busy = op != null || proc.status === 'loading';
                const isOnline = proc.status === 'online';
                const canUnload = proc.injected;
                // Refresh is meaningful whenever a hook may exist (so the user
                // can re-check the pipe and trigger a reconnect on demand).
                const showRefresh = proc.injected || proc.status === 'connecting' || proc.status === 'disconnected';
                return (
                  <motion.div
                    key={proc.pid}
                    initial={off ? false : { opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={off ? { duration: 0 } : { delay: 0.03 + idx * 0.025, duration: 0.22 }}
                    className="flex flex-col gap-3 rounded-xl border bg-card/50 p-3.5 transition-colors hover:bg-accent/20 sm:flex-row sm:items-center"
                  >
                    {/* icon + info stay horizontal; on phones the actions drop to
                        a second row so name / PID / path get the full width
                        instead of collapsing to "Q..". */}
                    <div className="flex min-w-0 flex-1 items-center gap-3">
                      <div
                        className={cn(
                          'flex size-10 shrink-0 items-center justify-center rounded-xl',
                          isOnline
                            ? 'bg-success/15 text-success'
                            : proc.status === 'error'
                              ? 'bg-destructive/15 text-destructive'
                              : 'bg-primary/10 text-primary'
                        )}
                      >
                        {isOnline ? (
                          <CheckCircle2 className="size-5" />
                        ) : proc.status === 'error' ? (
                          <AlertCircle className="size-5" />
                        ) : (
                          <Cpu className="size-5" />
                        )}
                      </div>
                      <div className="min-w-0 flex-1">
                        <div className="flex items-center gap-2">
                          <span className="min-w-0 truncate text-sm font-semibold">{proc.name || 'QQ.exe'}</span>
                          <Badge variant={processBadgeVariant(proc.status)} className="shrink-0 whitespace-nowrap">
                            {processStatusLabel[proc.status]}
                          </Badge>
                        </div>
                        <div className="mt-0.5 truncate font-mono text-[11px] text-muted-foreground tabular-nums">
                          PID {proc.pid}
                          {proc.uin && proc.uin !== '0' ? ` · UIN ${proc.uin}` : ''}
                        </div>
                        {proc.path && (
                          <div className="truncate text-[11px] text-muted-foreground/80" title={proc.path}>
                            {proc.path}
                          </div>
                        )}
                        {proc.error && (
                          <div className="mt-0.5 truncate text-[11px] text-destructive" title={proc.error}>
                            {proc.error}
                          </div>
                        )}
                      </div>
                    </div>
                    <div className="flex shrink-0 flex-wrap items-center gap-1.5">
                      <Button
                        size="sm"
                        variant="outline"
                        disabled={busy}
                        onClick={() => setProbeDialog({ pid: proc.pid, name: proc.name || `PID ${proc.pid}` })}
                      >
                        <Eye className="size-3.5" /> 探测登录
                      </Button>
                      {showRefresh && (
                        <Button
                          size="icon"
                          variant="ghost"
                          disabled={busy}
                          aria-label={`刷新进程 ${proc.pid} 管道状态`}
                          title="刷新管道状态 / 重连"
                          onClick={() => refresh(proc.pid)}
                          className="size-8 text-muted-foreground hover:text-foreground"
                        >
                          {refreshing ? (
                            <Loader2 className="size-3.5 animate-spin" />
                          ) : (
                            <RefreshCw className="size-3.5" />
                          )}
                        </Button>
                      )}
                      <Button
                        size="sm"
                        variant={canUnload ? 'outline' : 'default'}
                        disabled={busy}
                        onClick={() =>
                          setConfirm({
                            kind: canUnload ? 'unload' : 'load',
                            pid: proc.pid,
                            name: proc.name || `PID ${proc.pid}`,
                          })
                        }
                        className={cn(
                          canUnload && 'text-destructive hover:bg-destructive/10 hover:text-destructive'
                        )}
                      >
                        {(loading || unloading) && <Loader2 className="size-3.5 animate-spin" />}
                        {!loading && !unloading && canUnload && <Unplug className="size-3.5" />}
                        {canUnload ? (unloading ? '卸载中' : '卸载') : loading ? '加载中' : '加载'}
                      </Button>
                    </div>
                  </motion.div>
                );
              })}
            </div>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={!!confirm}
        onOpenChange={(o) => !o && setConfirm(null)}
        title={confirm?.kind === 'unload' ? '确认卸载 SnowLuma？' : '确认加载 SnowLuma？'}
        description={
          confirm
            ? confirm.kind === 'unload'
              ? `将从进程 ${confirm.name} 卸载 SnowLuma 注入，可能导致当前会话断开。`
              : `将向进程 ${confirm.name} 注入 SnowLuma，并开始监听登录状态。`
            : ''
        }
        confirmText={confirm?.kind === 'unload' ? '卸载' : '加载'}
        destructive={confirm?.kind === 'unload'}
        onConfirm={async () => {
          if (!confirm) return;
          if (confirm.kind === 'unload') await unload(confirm.pid);
          else await load(confirm.pid);
        }}
      />

      {probeDialog && (
        <ProcessProbeDialog
          pid={probeDialog.pid}
          processName={probeDialog.name}
          open={!!probeDialog}
          onOpenChange={(open) => !open && setProbeDialog(null)}
        />
      )}
    </div>
  );
}
