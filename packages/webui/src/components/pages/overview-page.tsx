import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Link } from '@tanstack/react-router';
import {
  Activity, ArrowRight, Bell, Cable, Check, Cpu, MemoryStick, MonitorCog, Pencil, PlugZap,
  RefreshCw, RotateCcw, Server, Users,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Progress } from '@/components/ui/progress';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Skeleton } from '@/components/ui/skeleton';
import { cn, formatBytes, formatUptime } from '@/lib/utils';
import type { AppPath } from '@/router';
import type { AdapterStatus, AdapterStatusLevel, LogEntry, LogLevel, UiLayoutItem } from '@/types';
import { useApi } from '@/lib/api';
import { useAppState } from '@/contexts/AppStateContext';
import { useSession } from '@/contexts/SessionContext';
import { useTheme } from '@/contexts/ThemeContext';
import { useLayout } from '@/contexts/LayoutContext';
import { useMediaQuery } from '@/hooks/use-media-query';
import {
  CONFIGURABLE_WIDGETS, GRID_COLS, parseAlertsConfig, parseSessionsConfig, widgetLabel,
  type AlertsConfig, type SessionsConfig,
} from '@/lib/dashboard-layout';
import { Dialog, DialogContent, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { DashboardGrid, type GridCoord } from '@/components/pages/dashboard-grid';
import { AlertsConfigForm, SessionsConfigForm } from '@/components/pages/widget-config-forms';

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

function renderWidget(block: UiLayoutItem): ReactNode {
  if (block.id.startsWith('stat:')) return <StatTileWidget id={block.id} />;
  switch (block.id) {
    case 'connections': return <ConnectionsBlock />;
    case 'alerts': return <RecentAlertsCard config={parseAlertsConfig(block.config)} />;
    case 'host': return <HostBlock />;
    case 'sessions': return <SessionsBlock config={parseSessionsConfig(block.config)} />;
    default: return null;
  }
}

export function OverviewPage() {
  const { qqList, processList } = useAppState();
  const { overviewBlocks, setOverviewBlocks, resetLayout, editing: editingCtx, setEditing } = useLayout();
  const off = useTheme().appearance.disableMotion;
  const isWide = useMediaQuery('(min-width: 768px)');
  // Free-grid editing is desktop-only (no room to drag/resize on a phone).
  const editing = isWide && editingCtx;
  const [configId, setConfigId] = useState<string | null>(null);

  const visibleBlocks = useMemo(() => overviewBlocks.filter((b) => b.visible), [overviewBlocks]);
  // In edit mode show ALL blocks (hidden ones as re-enableable ghosts); else visible-only.
  const gridBlocks = editing ? overviewBlocks : visibleBlocks;

  const onGridChange = (coords: GridCoord[]) => {
    const cmap = new Map(coords.map((c) => [c.id, c]));
    setOverviewBlocks(
      overviewBlocks.map((b) => {
        const c = cmap.get(b.id);
        return c ? { ...b, x: c.x, y: c.y, w: c.w, h: c.h } : b;
      }),
    );
  };

  const toggleBlock = (id: string) =>
    setOverviewBlocks(overviewBlocks.map((b) => (b.id === id ? { ...b, visible: !b.visible } : b)));

  const setBlockConfig = (id: string, config: Record<string, unknown>) =>
    setOverviewBlocks(overviewBlocks.map((b) => (b.id === id ? { ...b, config: { ...b.config, ...config } } : b)));

  const loadableProcs = processList.filter((p) => !p.injected).length;
  const configBlock = configId ? overviewBlocks.find((b) => b.id === configId) : null;

  return (
    <div className="flex flex-col gap-5">
      {/* Toolbar: edit toggle is desktop-only. In edit mode the cards carry
          their own floating drag/hide/settings overlays, and the sidebar nav
          becomes drag-sortable — no separate editor panel. */}
      {isWide && (
        <div className="flex items-center justify-end gap-2">
          {editing && (
            <Button variant="ghost" size="sm" onClick={resetLayout} className="text-muted-foreground">
              <RotateCcw className="size-3.5" /> 恢复默认
            </Button>
          )}
          <Button variant={editing ? 'default' : 'outline'} size="sm" onClick={() => setEditing(!editingCtx)}>
            {editing ? <><Check className="size-3.5" /> 完成</> : <><Pencil className="size-3.5" /> 编辑布局</>}
          </Button>
        </div>
      )}

      {editing && (
        <p className="rounded-xl border border-primary/20 bg-primary/5 px-3.5 py-2.5 text-[11px] leading-relaxed text-muted-foreground">
          拖动卡片顶部的「拖动」手柄移动位置、拖右下角缩放；眼睛图标显隐、齿轮改设置。左侧导航也可在编辑态拖动排序。
        </p>
      )}

      {/* First-run nudge — always shown (not a grid widget) so it can't be hidden. */}
      {qqList.length === 0 && (
        <motion.div initial={off ? false : { opacity: 0, y: -4 }} animate={{ opacity: 1, y: 0 }}>
          <Link
            to="/processes"
            className="flex items-center gap-3 rounded-xl border border-primary/30 bg-primary/5 px-4 py-3 transition-colors hover:bg-primary/10"
          >
            <div className="flex size-9 shrink-0 items-center justify-center rounded-xl bg-primary/15 text-primary">
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

      {visibleBlocks.length === 0 && !editing ? (
        <EmptyLayout onReset={resetLayout} />
      ) : (
        <DashboardGrid
          blocks={gridBlocks}
          editing={editing}
          cols={isWide ? GRID_COLS : 1}
          onChange={onGridChange}
          renderWidget={renderWidget}
          labelFor={widgetLabel}
          configurableIds={CONFIGURABLE_WIDGETS}
          onToggleVisible={toggleBlock}
          onConfigOpen={setConfigId}
        />
      )}

      <Dialog open={!!configId} onOpenChange={(o) => { if (!o) setConfigId(null); }}>
        <DialogContent className="max-w-sm">
          <DialogHeader>
            <DialogTitle>{configBlock ? `${widgetLabel(configBlock.id)} · 设置` : '设置'}</DialogTitle>
          </DialogHeader>
          {configBlock?.id === 'alerts' && <AlertsConfigForm config={configBlock.config} onChange={(c) => setBlockConfig('alerts', c)} />}
          {configBlock?.id === 'sessions' && <SessionsConfigForm config={configBlock.config} onChange={(c) => setBlockConfig('sessions', c)} />}
        </DialogContent>
      </Dialog>
    </div>
  );
}

function EmptyLayout({ onReset }: { onReset: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-muted-foreground">
      <MonitorCog className="size-8 opacity-40" strokeWidth={1.5} />
      <p className="text-sm">所有总览卡片都已隐藏</p>
      <Button variant="outline" size="sm" onClick={onReset}>恢复默认布局</Button>
    </div>
  );
}

// ─────────────── stat tiles (one widget each) ───────────────

function StatTile({
  icon, label, value, subtext, accent = false, to,
}: {
  icon: ReactNode;
  label: string;
  value: ReactNode;
  subtext?: ReactNode;
  accent?: boolean;
  to?: AppPath;
}) {
  const body = (
    <CardContent className="flex h-full items-center gap-3 overflow-hidden px-4 py-3.5">
      <div
        className={cn(
          'flex size-10 shrink-0 items-center justify-center rounded-xl',
          accent ? 'bg-primary text-primary-foreground' : 'bg-primary/10 text-primary',
        )}
      >
        {icon}
      </div>
      <div className="min-w-0 flex-1">
        <p className="truncate text-[11px] font-medium uppercase leading-tight tracking-wider text-muted-foreground">{label}</p>
        <div className="mt-1 truncate text-lg font-semibold leading-tight tabular-nums">{value}</div>
        {subtext && <p className="mt-1 truncate text-[11px] leading-tight text-muted-foreground">{subtext}</p>}
      </div>
      {to && <ArrowRight className="size-4 shrink-0 text-muted-foreground/60" />}
    </CardContent>
  );
  if (to) {
    return (
      <Link to={to} className="block h-full rounded-xl outline-none">
        <Card className="h-full overflow-hidden transition-colors hover:border-primary/40 hover:bg-accent/30">{body}</Card>
      </Link>
    );
  }
  return <Card className="h-full overflow-hidden">{body}</Card>;
}

function StatTileWidget({ id }: { id: string }) {
  const { qqList, processList, systemInfo } = useAppState();
  const { status } = useSession();
  const online = status === '已连接';

  switch (id) {
    case 'stat:status':
      return (
        <StatTile
          icon={<Activity className="size-5" />}
          label="服务状态"
          value={online ? '运行中' : status}
          subtext={online ? '已连接到后端' : '请检查后端进程'}
          accent={online}
        />
      );
    case 'stat:accounts':
      return (
        <StatTile
          icon={<Users className="size-5" />}
          label="在线账号"
          value={qqList.length}
          subtext={`已接入 ${qqList.length} 个会话`}
        />
      );
    case 'stat:processes': {
      const onlineProcs = processList.filter((p) => p.status === 'online').length;
      const loadableProcs = processList.filter((p) => !p.injected).length;
      return (
        <StatTile
          icon={<PlugZap className="size-5" />}
          label="进程注入"
          value={`${onlineProcs} 在线`}
          subtext={`${processList.length} 进程 · ${loadableProcs} 可注入`}
          to="/processes"
        />
      );
    }
    case 'stat:host':
      return (
        <StatTile
          icon={<Server className="size-5" />}
          label="主机名"
          value={systemInfo?.hostname ?? '—'}
          subtext={systemInfo ? `${systemInfo.platform} · ${systemInfo.arch}` : '加载中'}
        />
      );
    case 'stat:uptime':
      return (
        <StatTile
          icon={<MonitorCog className="size-5" />}
          label="系统运行"
          value={systemInfo ? formatUptime(systemInfo.uptime) : '—'}
          subtext={systemInfo ? `进程 ${formatUptime(systemInfo.processUptime)}` : undefined}
        />
      );
    default:
      return null;
  }
}

// ─────────────── host resources ───────────────

function HostBlock() {
  const { systemInfo, refreshSystem } = useAppState();
  return (
    <Card className="flex h-full flex-col">
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
      <CardContent className="grid flex-1 grid-cols-1 gap-4 lg:grid-cols-3">
        {/* CPU */}
        <div className="rounded-xl border bg-card/40 p-4">
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
                <div key={i} title={`Core ${i}: ${p.toFixed(1)}%`} className="h-6 rounded-sm bg-muted overflow-hidden flex items-end">
                  <div className="w-full bg-primary/70 transition-[height] duration-500" style={{ height: `${Math.max(4, p)}%` }} />
                </div>
              ))}
            </div>
          )}
        </div>
        {/* Memory */}
        <div className="rounded-xl border bg-card/40 p-4">
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
        <div className="rounded-xl border bg-card/40 p-4">
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
  );
}

// ─────────────── online sessions ───────────────

function SessionsBlock({ config }: { config: SessionsConfig }) {
  const { qqList } = useAppState();
  const off = useTheme().appearance.disableMotion;
  const list = useMemo(() => {
    const f = config.filter.trim().toLowerCase();
    let arr = f
      ? qqList.filter((q) => (q.nickname ?? '').toLowerCase().includes(f) || q.uin.includes(f))
      : qqList;
    if (config.sort === 'uin') arr = [...arr].sort((a, b) => a.uin.localeCompare(b.uin, undefined, { numeric: true }));
    else if (config.sort === 'nickname') arr = [...arr].sort((a, b) => (a.nickname ?? '').localeCompare(b.nickname ?? ''));
    // 'recent' keeps the server/insertion order.
    return arr;
  }, [qqList, config.sort, config.filter]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle>在线会话</CardTitle>
        <CardDescription>
          当前已接入并完成登录的 QQ 账号{config.filter.trim() ? `（筛选：${config.filter.trim()}）` : ''}
        </CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1">
        {list.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
            <Users className="size-8 opacity-40" strokeWidth={1.5} />
            <p className="text-sm">{qqList.length === 0 ? '暂无在线会话' : '无匹配的会话'}</p>
          </div>
        ) : (
          <ScrollArea className="h-full" viewportClassName="[&>div]:!block">
            <div className="grid grid-cols-1 gap-3 sm:grid-cols-2 xl:grid-cols-3 2xl:grid-cols-4">
              {list.map((q, idx) => (
                <motion.div
                  key={q.uin}
                  initial={off ? false : { opacity: 0, y: 6 }}
                  animate={{ opacity: 1, y: 0 }}
                  transition={off ? { duration: 0 } : { delay: 0.03 + idx * 0.04, duration: 0.22 }}
                  whileHover={off ? undefined : { y: -2 }}
                  className="flex items-center gap-3 rounded-xl border bg-card/40 p-3"
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
  ok: '正常', warn: '注意', down: '异常', disabled: '未启用',
};
const ADAPTER_KIND_LABEL: Record<AdapterStatus['kind'], string> = {
  httpServer: 'HTTP 服务端', httpClient: 'HTTP 上报', wsServer: 'WS 服务端', wsClient: 'WS 客户端',
};

function ConnectionsBlock() {
  const { connections } = useAppState();
  return (
    <Card className="flex h-full flex-col">
      <CardHeader>
        <CardTitle className="flex items-center gap-2">
          <Cable className="size-4 text-primary" /> OneBot 连接
        </CardTitle>
        <CardDescription>各账号协议端点的实时连接状态</CardDescription>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto">
        {connections.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
            <Cable className="size-8 opacity-40" strokeWidth={1.5} />
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
                  <p className="rounded-md border border-dashed px-3 py-2 text-[11px] text-muted-foreground">未配置任何协议端点</p>
                ) : (
                  <div className="flex flex-col gap-1.5">
                    {acc.adapters.map((adp) => (
                      <div key={adp.name} className="flex items-center gap-2 rounded-xl border bg-card/40 px-3 py-2">
                        <span className={cn('shrink-0 rounded px-1.5 py-0.5 text-[10px] font-medium', CONN_STATUS_STYLE[adp.status])}>
                          {CONN_STATUS_LABEL[adp.status]}
                        </span>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-center gap-1.5">
                            <span className="truncate text-sm font-medium">{adp.name}</span>
                            <span className="shrink-0 text-[10px] text-muted-foreground">{ADAPTER_KIND_LABEL[adp.kind]}</span>
                          </div>
                          <div className="truncate text-[11px] text-muted-foreground">{adp.detail}</div>
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

const ALERT_LEVEL_CLASS: Record<LogLevel, string> = {
  trace: 'text-muted-foreground/60',
  debug: 'text-muted-foreground',
  info: 'text-primary',
  success: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive',
};

function RecentAlertsCard({ config }: { config: AlertsConfig }) {
  const api = useApi();
  const { formatClock } = useTheme();
  const [alerts, setAlerts] = useState<LogEntry[]>([]);
  const { count } = config;
  const levelsKey = config.levels.join(',');

  useEffect(() => {
    const levels = new Set(levelsKey.split(',') as LogLevel[]);
    let active = true;
    api.logs
      .list(Math.max(200, count * 4))
      .then((list) => {
        if (!active) return;
        setAlerts(list.filter((l) => levels.has(l.level)).slice(-count));
      })
      .catch(() => { /* ignore */ });
    const stop = api.logs.stream({
      onLine: (entry) => {
        if (!levels.has(entry.level)) return;
        setAlerts((prev) => [...prev.filter((a) => a.id !== entry.id), entry].slice(-count));
      },
    });
    return () => { active = false; stop(); };
  }, [api, count, levelsKey]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="flex items-center gap-2">
            <Bell className="size-4 text-primary" /> 最近告警
          </CardTitle>
          <CardDescription>最近 {count} 条 · {config.levels.map((l) => l.toUpperCase()).join(' / ')}</CardDescription>
        </div>
        <Link to="/logs" className="inline-flex shrink-0 items-center gap-1 text-[11px] text-muted-foreground hover:text-foreground">
          查看日志 <ArrowRight className="size-3" />
        </Link>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto">
        {alerts.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
            <Bell className="size-8 opacity-40" strokeWidth={1.5} />
            <p className="text-sm">暂无告警</p>
          </div>
        ) : (
          <div className="flex flex-col gap-1 font-mono text-[11px]">
            {alerts.map((a) => (
              <div key={a.id} className="flex gap-2 rounded px-2 py-1 hover:bg-accent/30">
                <span className="shrink-0 text-muted-foreground tabular-nums">{formatClock(a.time)}</span>
                <span className={cn('shrink-0 font-semibold', ALERT_LEVEL_CLASS[a.level])}>
                  {a.level.toUpperCase()}
                </span>
                <span className="min-w-0 flex-1 truncate" title={a.message}>[{a.scope}] {a.message}</span>
              </div>
            ))}
          </div>
        )}
      </CardContent>
    </Card>
  );
}
