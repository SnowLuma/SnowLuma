import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { Link } from '@tanstack/react-router';
import {
  Activity,
  ArrowRight,
  Bell,
  Cable,
  Cpu,
  MemoryStick,
  MonitorCog,
  PlugZap,
  RefreshCw,
  Server,
  Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatBytes, formatUptime } from '@/lib/utils';
import type { AppPath } from '@/router';
import type { AccountConnections, AdapterStatus, AdapterStatusLevel, LogEntry } from '@/types';
import { useApi } from '@/lib/api';
import { useAppState } from '@/contexts/AppStateContext';
import { useSession } from '@/contexts/SessionContext';

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

function StatTile({
  icon,
  label,
  value,
  subtext,
  accent = false,
  to,
}: {
  icon: React.ReactNode;
  label: string;
  value: React.ReactNode;
  subtext?: React.ReactNode;
  accent?: boolean;
  /** When set, the whole tile becomes a link to this route. */
  to?: AppPath;
}) {
  const body = (
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
      {to && <ArrowRight className="size-4 shrink-0 text-muted-foreground/60" />}
    </CardContent>
  );

  if (to) {
    return (
      <Link to={to} className="block rounded-xl outline-none">
        <Card className="overflow-hidden transition-colors hover:border-primary/40 hover:bg-accent/30">{body}</Card>
      </Link>
    );
  }
  return <Card className="overflow-hidden">{body}</Card>;
}

export function OverviewPage() {
  const { qqList, processList, systemInfo, connections, refreshSystem } = useAppState();
  const { status } = useSession();

  // Lightweight tick to refresh "uptime" pretty-print every 30s
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((v) => v + 1), 30_000);
    return () => clearInterval(t);
  }, []);

  const online = status === '已连接';
  // Read-only injection health for the dashboard. Control lives on /processes.
  const onlineProcs = processList.filter((p) => p.status === 'online').length;
  const loadableProcs = processList.filter((p) => !p.injected).length;

  return (
    <div className="flex flex-col gap-6">
      {/* Top stats */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 sm:gap-4 lg:grid-cols-5">
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
          icon={<PlugZap className="size-5" />}
          label="进程注入"
          value={`${onlineProcs} 在线`}
          subtext={`${processList.length} 进程 · ${loadableProcs} 可注入`}
          to="/processes"
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

      {/* First-run nudge: nothing online yet → point at the injection page. */}
      {qqList.length === 0 && (
        <motion.div initial={{ opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
          <Link
            to="/processes"
            className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 transition-colors hover:bg-primary/10"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-primary/15 text-primary">
              <PlugZap className="size-5" />
            </div>
            <div className="min-w-0 flex-1">
              <p className="text-sm font-medium">
                {loadableProcs > 0 ? `检测到 ${loadableProcs} 个可加载 QQ 进程` : '尚未接入任何账号'}
              </p>
              <p className="text-[11px] text-muted-foreground">
                前往「进程注入」加载 QQ，登录后会自动接入 OneBot 流程。
              </p>
            </div>
            <ArrowRight className="size-4 shrink-0 text-primary" />
          </Link>
        </motion.div>
      )}

      {/* Operational health — connection status + recent alerts (side by side on wide screens) */}
      <div className="grid gap-6 xl:grid-cols-2">
        <ConnectionsCard connections={connections} />
        <RecentAlertsCard />
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
          <Button variant="outline" size="sm" onClick={refreshSystem}>
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
              <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
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
    </div>
  );
}

// ─────────────── connection health ───────────────

const CONN_STATUS_STYLE: Record<AdapterStatusLevel, string> = {
  ok: 'bg-success/10 text-success',
  warn: 'bg-warning/10 text-warning',
  down: 'bg-destructive/10 text-destructive',
  disabled: 'bg-muted text-muted-foreground',
};
const CONN_STATUS_LABEL: Record<AdapterStatusLevel, string> = {
  ok: '正常',
  warn: '注意',
  down: '异常',
  disabled: '未启用',
};
const ADAPTER_KIND_LABEL: Record<AdapterStatus['kind'], string> = {
  httpServer: 'HTTP 服务端',
  httpClient: 'HTTP 上报',
  wsServer: 'WS 服务端',
  wsClient: 'WS 客户端',
};

function ConnectionsCard({ connections }: { connections: AccountConnections[] }) {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cable className="size-4 text-primary" /> OneBot 连接
        </CardTitle>
        <CardDescription>各账号协议端点的实时连接状态</CardDescription>
      </CardHeader>
      <CardContent>
        {connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
            <Cable className="size-7" strokeWidth={1.5} />
            <p className="text-sm">暂无已接入的账号实例</p>
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {connections.map((acc) => (
              <div key={acc.uin} className="flex flex-col gap-2">
                <div className="flex items-baseline gap-2">
                  <span className="text-sm font-semibold">{acc.nickname || acc.uin}</span>
                  <span className="font-mono text-[11px] text-muted-foreground tabular-nums">{acc.uin}</span>
                </div>
                {acc.adapters.length === 0 ? (
                  <p className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">
                    未配置任何协议端点
                  </p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {acc.adapters.map((a) => (
                      <div key={a.name} className="flex items-center gap-2 rounded-lg border bg-card/40 px-3 py-2">
                        <span
                          className={cn(
                            'shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium',
                            CONN_STATUS_STYLE[a.status],
                          )}
                        >
                          {CONN_STATUS_LABEL[a.status]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{a.name}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">{ADAPTER_KIND_LABEL[a.kind]}</span>
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">{a.detail}</div>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}

// ─────────────── recent alerts ───────────────

function alertClock(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleTimeString();
}

function RecentAlertsCard() {
  const api = useApi();
  const [alerts, setAlerts] = useState<LogEntry[]>([]);

  useEffect(() => {
    let active = true;
    api.logs
      .list(200)
      .then((list) => {
        if (!active) return;
        setAlerts(list.filter((l) => l.level === 'warn' || l.level === 'error').slice(-5));
      })
      .catch(() => { /* ignore */ });
    const stop = api.logs.stream({
      onLine: (entry) => {
        if (entry.level !== 'warn' && entry.level !== 'error') return;
        setAlerts((prev) => [...prev.filter((a) => a.id !== entry.id), entry].slice(-5));
      },
    });
    return () => {
      active = false;
      stop();
    };
  }, [api]);

  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bell className="size-4 text-primary" /> 最近告警
          </CardTitle>
          <CardDescription>最近的 warn / error 级别日志</CardDescription>
        </div>
        <Link
          to="/logs"
          className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground"
        >
          查看日志 <ArrowRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent>
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-lg border border-dashed py-10 text-muted-foreground">
            <Bell className="size-7" strokeWidth={1.5} />
            <p className="text-sm">暂无告警</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {alerts.map((a) => (
              <div key={a.id} className="flex gap-2 rounded px-2 py-1 hover:bg-accent/30">
                <span className="shrink-0 text-muted-foreground tabular-nums">{alertClock(a.time)}</span>
                <span className={cn('shrink-0 font-semibold', a.level === 'error' ? 'text-destructive' : 'text-warning')}>
                  {a.level.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate" title={a.message}>
                  [{a.scope}] {a.message}
                </span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
