import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import {
  Activity,
  AlertCircle,
  CheckCircle2,
  Cpu,
  Loader2,
  MemoryStick,
  MonitorCog,
  RefreshCw,
  Server,
  Unplug,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn, formatBytes, formatUptime } from '@/lib/utils';
import type { HookProcessInfo, QQInfo, SystemInfo } from '@/types';
import type { HookProcessOps } from '@/hooks/use-hook-process-ops';

interface OverviewPageProps {
  qqList: QQInfo[];
  status: string;
  processList: HookProcessInfo[];
  systemInfo: SystemInfo | null;
  onRefreshProcesses: () => void;
  onRefreshSystem: () => void;
  processOps: HookProcessOps;
}

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

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

function StatTile({
  icon,
  label,
  value,
  subtext,
  accent = false,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  subtext?: React.ReactNode;
  accent?: boolean;
}) {
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex items-center gap-3 p-4">
        <div
          className={cn(
            'flex size-10 shrink-0 items-center justify-center rounded-xl',
            accent ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary'
          )}
        >
          {icon}
        </div>
        <div className="min-w-0 flex-1">
          <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
          <div className="mt-0.5 truncate text-base font-semibold tabular-nums">{value}</div>
          {subtext && <p className="mt-0.5 truncate text-[11px] text-muted-foreground">{subtext}</p>}
        </div>
      </CardContent>
    </Card>
  );
}

export function OverviewPage({
  qqList,
  status,
  processList,
  systemInfo,
  onRefreshProcesses,
  onRefreshSystem,
  processOps,
}: OverviewPageProps) {
  const { statusOf, banner: processActionStatus, load, unload, refresh } = processOps;
  const [confirm, setConfirm] = useState<
    | { kind: 'load' | 'unload'; pid: number; name: string }
    | null
  >(null);

  // Lightweight tick to refresh "uptime" pretty-print every 30s
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const online = status === '已连接';

  return (
    <div className="flex flex-col gap-6">
      {/* Top stats */}
      <div className="grid grid-cols-2 gap-3 sm:gap-4 md:grid-cols-4">
        <StatTile
          icon={<Activity className="size-5" />}
          label="服务状态"
          value={online ? '运行中' : status}
          subtext={online ? '已连接到后端' : '请检查后端进程'}
          accent={online}
        />
        <StatTile
          icon={<Users className="size-5" />}
          label="在线账号"
          value={qqList.length}
          subtext={`已接入 ${qqList.length} 个会话`}
        />
        <StatTile
          icon={<Server className="size-5" />}
          label="主机名"
          value={systemInfo?.hostname ?? '—'}
          subtext={systemInfo ? `${systemInfo.platform} · ${systemInfo.arch}` : '加载中'}
        />
        <StatTile
          icon={<MonitorCog className="size-5" />}
          label="系统运行"
          value={systemInfo ? formatUptime(systemInfo.uptime) : '—'}
          subtext={systemInfo ? `进程 ${formatUptime(systemInfo.processUptime)}` : undefined}
        />
      </div>

      {/* System metrics */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>主机资源</CardTitle>
            <CardDescription>
              {systemInfo
                ? `${systemInfo.cpu.model.trim()} · ${systemInfo.cpu.cores} 核 · Node ${systemInfo.nodeVersion}`
                : '正在采集主机信息…'}
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onRefreshSystem}>
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
        </CardHeader>
        <CardContent className="grid grid-cols-1 gap-4 lg:grid-cols-3">
          {/* CPU */}
          <div className="rounded-lg border bg-card/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Cpu className="size-4 text-primary" />
                <span className="text-sm font-semibold">CPU 使用率</span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-primary">
                {systemInfo ? `${systemInfo.cpu.average.toFixed(1)}%` : '—'}
              </span>
            </div>
            <Progress value={systemInfo?.cpu.average ?? 0} />
            <p className="mt-2 text-[11px] text-muted-foreground">
              负载: {systemInfo ? systemInfo.cpu.loadAvg.map((v) => v.toFixed(2)).join(' / ') : '—'}
            </p>
            {systemInfo && systemInfo.cpu.perCore.length > 0 && (
              <div className="mt-3 grid grid-cols-8 gap-1">
                {systemInfo.cpu.perCore.map((p, i) => (
                  <div
                    key={i}
                    title={`Core ${i}: ${p.toFixed(1)}%`}
                    className="h-6 rounded-sm bg-muted overflow-hidden flex items-end"
                  >
                    <div
                      className="w-full bg-primary/70 transition-[height] duration-500"
                      style={{ height: `${Math.max(4, p)}%` }}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* Memory */}
          <div className="rounded-lg border bg-card/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <MemoryStick className="size-4 text-primary" />
                <span className="text-sm font-semibold">内存使用</span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-primary">
                {systemInfo ? `${systemInfo.memory.usagePercent.toFixed(1)}%` : '—'}
              </span>
            </div>
            <Progress value={systemInfo?.memory.usagePercent ?? 0} />
            <div className="mt-3 flex items-center justify-between text-[11px] text-muted-foreground tabular-nums">
              <span>已用 {systemInfo ? formatBytes(systemInfo.memory.used) : '—'}</span>
              <span>共 {systemInfo ? formatBytes(systemInfo.memory.total) : '—'}</span>
            </div>
          </div>

          {/* Runtime */}
          <div className="rounded-lg border bg-card/40 p-4">
            <div className="mb-2 flex items-center justify-between">
              <div className="flex items-center gap-2">
                <Server className="size-4 text-primary" />
                <span className="text-sm font-semibold">运行进程</span>
              </div>
              <span className="text-sm font-semibold tabular-nums text-primary">
                {systemInfo ? `PID ${systemInfo.runtime.pid}` : '—'}
              </span>
            </div>
            {!systemInfo ? (
              <div className="space-y-2">
                <Skeleton className="h-4 w-3/4" />
                <Skeleton className="h-4 w-1/2" />
              </div>
            ) : (
              <div className="space-y-1.5 text-xs">
                <div className="flex items-center justify-between rounded-md bg-background/60 px-2 py-1.5">
                  <span className="text-muted-foreground">RSS</span>
                  <span className="font-medium tabular-nums">{formatBytes(systemInfo.runtime.rss)}</span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-background/60 px-2 py-1.5">
                  <span className="text-muted-foreground">堆内存</span>
                  <span className="font-medium tabular-nums">
                    {formatBytes(systemInfo.runtime.heapUsed)} / {formatBytes(systemInfo.runtime.heapTotal)}
                  </span>
                </div>
                <div className="flex items-center justify-between rounded-md bg-background/60 px-2 py-1.5">
                  <span className="text-muted-foreground">外部内存</span>
                  <span className="font-medium tabular-nums">{formatBytes(systemInfo.runtime.external)}</span>
                </div>
              </div>
            )}
          </div>
        </CardContent>
      </Card>

      {/* QQ Processes */}
      <Card>
        <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
          <div>
            <CardTitle>QQ 进程</CardTitle>
            <CardDescription>
              加载 SnowLuma 后会监听登录状态，登录后自动接入 OneBot 流程
            </CardDescription>
          </div>
          <Button variant="outline" size="sm" onClick={onRefreshProcesses}>
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
        </CardHeader>
        <CardContent>
          {processActionStatus && (
            <motion.div
              initial={{ opacity: 0, y: -4 }}
              animate={{ opacity: 1, y: 0 }}
              className="mb-3 rounded-md border border-primary/20 bg-primary/5 px-3 py-2 text-xs text-primary"
            >
              {processActionStatus}
            </motion.div>
          )}
          {processList.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
              <Cpu className="size-7" strokeWidth={1.5} />
              <p className="text-sm">未检测到可加载 QQ 主进程</p>
            </div>
          ) : (
            <div className="grid grid-cols-1 gap-3 xl:grid-cols-2">
              {processList.map((proc, idx) => {
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
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.03 + idx * 0.025, duration: 0.22 }}
                    className="flex items-center gap-3 rounded-lg border bg-card/50 p-3"
                  >
                    <div
                      className={cn(
                        'flex size-10 shrink-0 items-center justify-center rounded-lg',
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
                        <span className="truncate text-sm font-semibold">{proc.name || 'QQ.exe'}</span>
                        <Badge variant={processBadgeVariant(proc.status)}>{processStatusLabel[proc.status]}</Badge>
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
                    <div className="flex shrink-0 items-center gap-1.5">
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

      {/* Online accounts */}
      <Card>
        <CardHeader>
          <CardTitle>在线会话</CardTitle>
          <CardDescription>当前已接入并完成登录的 QQ 账号</CardDescription>
        </CardHeader>
        <CardContent>
          {qqList.length === 0 ? (
            <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
              <Users className="size-7" strokeWidth={1.5} />
              <p className="text-sm">暂无在线会话</p>
            </div>
          ) : (
            <ScrollArea className="max-h-[420px]" viewportClassName="[&>div]:!block">
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3">
                {qqList.map((q, idx) => (
                  <motion.div
                    key={q.uin}
                    initial={{ opacity: 0, y: 6 }}
                    animate={{ opacity: 1, y: 0 }}
                    transition={{ delay: 0.03 + idx * 0.04, duration: 0.22 }}
                    whileHover={{ y: -2 }}
                    className="flex items-center gap-3 rounded-lg border bg-card/40 p-3"
                  >
                    <Avatar size={40}>
                      <AvatarImage src={qqAvatarUrl(q.uin)} alt={q.nickname || q.uin} />
                      <AvatarFallback>{(q.nickname || q.uin).slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{q.nickname}</div>
                      <div className="truncate font-mono text-[11px] text-muted-foreground tabular-nums">{q.uin}</div>
                    </div>
                    <span className="size-2 shrink-0 animate-pulse rounded-full bg-success shadow-[0_0_8px_color-mix(in_oklab,var(--success)_60%,transparent)]" />
                  </motion.div>
                ))}
              </div>
            </ScrollArea>
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
    </div>
  );
}
