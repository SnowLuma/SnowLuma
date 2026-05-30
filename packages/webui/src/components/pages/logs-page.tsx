import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Pause, Play, RefreshCw, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import type { LogEntry, LogLevel } from '@/types';
import { useApi } from '@/lib/api';

const levelClass: Record<LogLevel, string> = {
  debug: 'text-muted-foreground',
  info: 'text-primary',
  success: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive',
};

const LEVELS: LogLevel[] = ['debug', 'info', 'success', 'warn', 'error'];

/** Show a locale time when the backend sends an ISO timestamp (it does);
 *  fall back to the raw string otherwise so we never render "Invalid Date". */
function formatTime(t: string): string {
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : d.toLocaleTimeString();
}

export function LogsPage() {
  const api = useApi();
  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [streamStatus, setStreamStatus] = useState('连接中');
  const [paused, setPaused] = useState(false);
  const [filter, setFilter] = useState('');
  const [enabledLevels, setEnabledLevels] = useState<Set<LogLevel>>(new Set(LEVELS));
  const [confirmClear, setConfirmClear] = useState(false);
  const [serverLevel, setServerLevel] = useState<LogLevel | null>(null);
  const [levelBusy, setLevelBusy] = useState(false);
  const endRef = useRef<HTMLDivElement | null>(null);
  const viewportRef = useRef<HTMLDivElement | null>(null);

  const loadLogs = useCallback(async () => {
    try {
      setLogs(await api.logs.list(500));
    } catch (e) {
      console.error('logs', e);
    }
  }, [api]);

  useEffect(() => {
    void loadLogs();
  }, [loadLogs]);

  useEffect(() => {
    api.logs.getLevel().then(({ level }) => setServerLevel(level)).catch((err) => {
      console.error('getLevel', err);
    });
  }, [api]);

  const changeServerLevel = useCallback(async (lv: LogLevel) => {
    if (lv === serverLevel || levelBusy) return;
    setLevelBusy(true);
    try {
      const { level } = await api.logs.setLevel(lv);
      setServerLevel(level);
    } catch (err) {
      console.error('setLevel', err);
    } finally {
      setLevelBusy(false);
    }
  }, [api, serverLevel, levelBusy]);

  useEffect(() => {
    return api.logs.stream({
      onLine: (entry) => {
        setLogs((prev) => [...prev.filter((it) => it.id !== entry.id), entry].slice(-1000));
      },
      onStatus: (s) => {
        if (s === 'open') setStreamStatus('实时');
        else if (s === 'reconnecting') setStreamStatus('重连中');
        else setStreamStatus('已断开');
      },
    });
  }, [api]);

  useEffect(() => {
    if (paused) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, paused]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    return logs.filter((l) => {
      if (!enabledLevels.has(l.level)) return false;
      if (!f) return true;
      return (
        l.message.toLowerCase().includes(f) ||
        l.scope.toLowerCase().includes(f) ||
        l.level.toLowerCase().includes(f)
      );
    });
  }, [logs, filter, enabledLevels]);

  const toggleLevel = (lv: LogLevel) => {
    setEnabledLevels((prev) => {
      const next = new Set(prev);
      if (next.has(lv)) next.delete(lv);
      else next.add(lv);
      return next;
    });
  };

  return (
    <Card className="flex h-[calc(100vh-7rem)] min-h-[480px] flex-col">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            运行日志
            <Badge variant={streamStatus === '实时' ? 'success' : 'secondary'}>{streamStatus}</Badge>
          </CardTitle>
          <CardDescription>
            最近 {filtered.length} / {logs.length} 条 · 通过 SSE 推送
          </CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="搜索消息 / 模块 / 级别"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-48"
          />
          <Button variant="outline" size="sm" onClick={() => setPaused((v) => !v)}>
            {paused ? <Play className="size-3.5" /> : <Pause className="size-3.5" />}
            {paused ? '继续' : '暂停'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadLogs()}>
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
          <Button
            variant="outline"
            size="sm"
            onClick={() => setConfirmClear(true)}
            className="text-muted-foreground hover:text-destructive"
          >
            <Trash2 className="size-3.5" /> 清空视图
          </Button>
        </div>
      </CardHeader>

      <div className="flex flex-wrap items-center gap-1 px-5 pb-2">
        <span className="mr-2 text-[11px] text-muted-foreground/80">视图过滤</span>
        {LEVELS.map((lv) => {
          const active = enabledLevels.has(lv);
          return (
            <button
              key={lv}
              type="button"
              onClick={() => toggleLevel(lv)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer',
                active
                  ? cn('border-transparent', levelClass[lv], 'bg-muted')
                  : 'border-border text-muted-foreground/60 line-through'
              )}
            >
              {lv.toUpperCase()}
            </button>
          );
        })}
      </div>

      <div className="flex flex-wrap items-center gap-1 px-5 pb-3">
        <span className="mr-2 text-[11px] text-muted-foreground/80" title="文件落盘始终为 debug，此处仅控制控制台 / 实时流的级别">
          服务端级别
        </span>
        {LEVELS.map((lv) => {
          const active = serverLevel === lv;
          return (
            <button
              key={lv}
              type="button"
              onClick={() => void changeServerLevel(lv)}
              disabled={levelBusy || serverLevel === null}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
                active
                  ? cn('border-primary', levelClass[lv], 'bg-primary/10')
                  : 'border-border text-muted-foreground/70 hover:text-foreground'
              )}
            >
              {lv.toUpperCase()}
            </button>
          );
        })}
      </div>

      <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-muted/30">
          <ScrollArea
            className="flex-1 min-h-0"
            viewportClassName="[&>div]:!block"
          >
            <div ref={viewportRef} className="font-mono text-xs">
              {filtered.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-muted-foreground">暂无日志</div>
              ) : (
                filtered.map((log) => (
                  <motion.div
                    key={log.id}
                    initial={{ opacity: 0 }}
                    animate={{ opacity: 1 }}
                    transition={{ duration: 0.12 }}
                    className="flex flex-col gap-0.5 px-3 py-1 leading-5 hover:bg-accent/30 sm:flex-row sm:gap-2 sm:py-0.5"
                  >
                    {/* Meta drops to its own line on phones so the message gets
                        the full width instead of a ~40px column that breaks
                        every few characters. On sm+ it's the dense single row. */}
                    <div className="flex shrink-0 items-center gap-2">
                      <span className="shrink-0 text-muted-foreground tabular-nums">{formatTime(log.time)}</span>
                      <span className={cn('shrink-0 font-semibold sm:w-14', levelClass[log.level])}>
                        {log.level.toUpperCase()}
                      </span>
                      <span className="min-w-0 truncate text-muted-foreground sm:w-28">[{log.scope}]</span>
                    </div>
                    <span className="min-w-0 whitespace-pre-wrap break-all">{log.message}</span>
                  </motion.div>
                ))
              )}
              <div ref={endRef} />
            </div>
          </ScrollArea>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空当前日志视图？"
        description="此操作仅清空浏览器视图中的日志，不会影响服务端的日志缓冲区。"
        confirmText="清空"
        destructive
        onConfirm={() => setLogs([])}
      />
    </Card>
  );
}
