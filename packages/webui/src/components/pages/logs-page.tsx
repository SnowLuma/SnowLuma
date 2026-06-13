import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowDownToLine, Highlighter, Pause, Plus, RefreshCw, Trash2, WrapText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import type { LogEntry, LogLevel, UiHighlightRule } from '@/types';
import { useApi } from '@/lib/api';
import { useTheme } from '@/contexts/ThemeContext';
import { useLayout } from '@/contexts/LayoutContext';

const levelClass: Record<LogLevel, string> = {
  trace: 'text-muted-foreground/60',
  debug: 'text-muted-foreground',
  info: 'text-primary',
  success: 'text-success',
  warn: 'text-warning',
  error: 'text-destructive',
};

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'success', 'warn', 'error'];

// Highlight palette — keyword rules tint a matching row. Stored as an id.
const HIGHLIGHT_COLORS: { id: string; label: string; swatch: string }[] = [
  { id: 'amber', label: '琥珀', swatch: '#f59e0b' },
  { id: 'rose', label: '玫瑰', swatch: '#f43f5e' },
  { id: 'emerald', label: '翡翠', swatch: '#10b981' },
  { id: 'sky', label: '天蓝', swatch: '#38bdf8' },
  { id: 'violet', label: '紫', swatch: '#8b5cf6' },
];
const colorSwatch = (id: string) => HIGHLIGHT_COLORS.find((c) => c.id === id)?.swatch ?? '#f59e0b';

function matchHighlight(message: string, rules: UiHighlightRule[]): string | null {
  if (rules.length === 0) return null;
  const m = message.toLowerCase();
  for (const r of rules) {
    if (r.keyword && m.includes(r.keyword.toLowerCase())) return colorSwatch(r.color);
  }
  return null;
}

export function LogsPage() {
  const api = useApi();
  const { formatClock } = useTheme();
  const { pages, setPages } = useLayout();
  const prefs = pages.logs;

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [streamStatus, setStreamStatus] = useState('连接中');
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [serverLevel, setServerLevel] = useState<LogLevel | null>(null);
  const [levelBusy, setLevelBusy] = useState(false);
  const [showHighlights, setShowHighlights] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [newColor, setNewColor] = useState(HIGHLIGHT_COLORS[0].id);
  const endRef = useRef<HTMLDivElement | null>(null);

  // maxLines is read through a ref so changing it doesn't re-subscribe the SSE.
  const maxLines = prefs.maxLines;
  const maxLinesRef = useRef(maxLines);
  useEffect(() => { maxLinesRef.current = maxLines; }, [maxLines]);

  const enabled = useMemo(() => new Set(prefs.visibleLevels as LogLevel[]), [prefs.visibleLevels]);

  const loadLogs = useCallback(async () => {
    try {
      // Backfill is capped at the server's ring-buffer size (1000); `maxLines`
      // can exceed that, but only the live SSE stream grows the view past 1000.
      setLogs(await api.logs.list(Math.min(1000, maxLinesRef.current)));
    } catch (e) {
      console.error('logs', e);
    }
  }, [api]);

  useEffect(() => { void loadLogs(); }, [loadLogs]);

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
        setLogs((prev) => [...prev.filter((it) => it.id !== entry.id), entry].slice(-maxLinesRef.current));
      },
      onStatus: (s) => {
        if (s === 'open') setStreamStatus('实时');
        else if (s === 'reconnecting') setStreamStatus('重连中');
        else setStreamStatus('已断开');
      },
    });
  }, [api]);

  useEffect(() => {
    if (!prefs.autoScroll) return;
    endRef.current?.scrollIntoView({ block: 'end' });
  }, [logs, prefs.autoScroll]);

  const filtered = useMemo(() => {
    const f = filter.trim().toLowerCase();
    const capped = logs.slice(-maxLines);
    return capped.filter((l) => {
      if (!enabled.has(l.level)) return false;
      if (!f) return true;
      return (
        l.message.toLowerCase().includes(f) ||
        l.scope.toLowerCase().includes(f) ||
        l.level.toLowerCase().includes(f) ||
        (l.req !== undefined && String(l.req).includes(f))
      );
    });
  }, [logs, filter, enabled, maxLines]);

  const toggleLevel = (lv: LogLevel) => {
    const next = new Set(enabled);
    if (next.has(lv)) next.delete(lv); else next.add(lv);
    setPages({ logs: { ...prefs, visibleLevels: LEVELS.filter((l) => next.has(l)) } });
  };

  const addHighlight = () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    setPages({ logs: { ...prefs, highlightRules: [...prefs.highlightRules, { keyword: kw, color: newColor }].slice(0, 20) } });
    setNewKeyword('');
  };
  const removeHighlight = (idx: number) => {
    setPages({ logs: { ...prefs, highlightRules: prefs.highlightRules.filter((_, i) => i !== idx) } });
  };

  return (
    <Card className="flex h-[calc(100vh-7rem)] min-h-[480px] flex-col">
      <CardHeader className="flex flex-col gap-3 space-y-0 sm:flex-row sm:items-center sm:justify-between">
        <div>
          <CardTitle className="flex items-center gap-2">
            运行日志
            <Badge variant={streamStatus === '实时' ? 'success' : 'secondary'}>{streamStatus}</Badge>
          </CardTitle>
          <CardDescription>最近 {filtered.length} / {logs.length} 条 · 通过 SSE 推送</CardDescription>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          <Input
            placeholder="搜索消息 / 模块 / 级别"
            value={filter}
            onChange={(e) => setFilter(e.target.value)}
            className="h-8 w-48"
          />
          <Button variant="outline" size="sm" onClick={() => setPages({ logs: { ...prefs, autoScroll: !prefs.autoScroll } })} title="自动滚动到底部">
            {prefs.autoScroll ? <ArrowDownToLine className="size-3.5 text-primary" /> : <Pause className="size-3.5" />}
            {prefs.autoScroll ? '自动滚动' : '已暂停'}
          </Button>
          <Button variant="outline" size="sm" onClick={() => setPages({ logs: { ...prefs, wrap: !prefs.wrap } })} title="自动换行">
            <WrapText className={cn('size-3.5', prefs.wrap && 'text-primary')} /> 换行
          </Button>
          <Button variant="outline" size="sm" onClick={() => setShowHighlights((v) => !v)} title="高亮规则">
            <Highlighter className={cn('size-3.5', prefs.highlightRules.length > 0 && 'text-primary')} /> 高亮
          </Button>
          <Button variant="outline" size="sm" onClick={() => void loadLogs()}>
            <RefreshCw className="size-3.5" /> 刷新
          </Button>
          <Button variant="outline" size="sm" onClick={() => setConfirmClear(true)} className="text-muted-foreground hover:text-destructive">
            <Trash2 className="size-3.5" /> 清空视图
          </Button>
        </div>
      </CardHeader>

      {showHighlights && (
        <div className="mx-5 mb-2 flex flex-col gap-2 rounded-lg border bg-muted/20 p-3">
          <div className="flex flex-wrap items-center gap-2">
            <Input
              placeholder="高亮关键词"
              value={newKeyword}
              maxLength={50}
              onChange={(e) => setNewKeyword(e.target.value)}
              onKeyDown={(e) => { if (e.key === 'Enter') addHighlight(); }}
              className="h-8 w-44"
            />
            <div className="flex items-center gap-1">
              {HIGHLIGHT_COLORS.map((c) => (
                <button
                  key={c.id}
                  type="button"
                  onClick={() => setNewColor(c.id)}
                  title={c.label}
                  aria-label={c.label}
                  className={cn('size-6 rounded-full border transition-transform hover:scale-110 cursor-pointer', newColor === c.id ? 'ring-2 ring-offset-1 ring-foreground/40' : 'border-border')}
                  style={{ backgroundColor: c.swatch }}
                />
              ))}
            </div>
            <Button variant="outline" size="sm" onClick={addHighlight} disabled={!newKeyword.trim()}>
              <Plus className="size-3.5" /> 添加
            </Button>
          </div>
          {prefs.highlightRules.length > 0 && (
            <div className="flex flex-wrap gap-1.5">
              {prefs.highlightRules.map((r, i) => (
                <span key={i} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: colorSwatch(r.color) }}>
                  <span className="size-2 rounded-full" style={{ backgroundColor: colorSwatch(r.color) }} />
                  {r.keyword}
                  <button type="button" onClick={() => removeHighlight(i)} className="text-muted-foreground hover:text-destructive cursor-pointer" aria-label="移除">
                    <X className="size-3" />
                  </button>
                </span>
              ))}
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap items-center gap-1 px-5 pb-2">
        <span className="mr-2 text-[11px] text-muted-foreground/80">视图过滤</span>
        {LEVELS.map((lv) => {
          const active = enabled.has(lv);
          return (
            <button
              key={lv}
              type="button"
              onClick={() => toggleLevel(lv)}
              className={cn(
                'rounded-full border px-2.5 py-0.5 text-[11px] font-medium transition-colors cursor-pointer',
                active ? cn('border-transparent', levelClass[lv], 'bg-muted') : 'border-border text-muted-foreground/60 line-through',
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
                active ? cn('border-primary', levelClass[lv], 'bg-primary/10') : 'border-border text-muted-foreground/70 hover:text-foreground',
              )}
            >
              {lv.toUpperCase()}
            </button>
          );
        })}
      </div>

      <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
        <div className="flex min-h-0 flex-1 flex-col rounded-lg border bg-muted/30">
          <ScrollArea className="flex-1 min-h-0" viewportClassName="[&>div]:!block">
            <div className="font-mono text-xs">
              {filtered.length === 0 ? (
                <div className="flex h-40 items-center justify-center text-muted-foreground">暂无日志</div>
              ) : (
                filtered.map((log) => {
                  const hl = matchHighlight(log.message, prefs.highlightRules);
                  return (
                    <motion.div
                      key={log.id}
                      initial={{ opacity: 0 }}
                      animate={{ opacity: 1 }}
                      transition={{ duration: 0.12 }}
                      className="flex flex-col gap-0.5 px-3 py-1 leading-5 hover:bg-accent/30 sm:flex-row sm:gap-2 sm:py-0.5"
                      style={hl ? { boxShadow: `inset 3px 0 0 ${hl}`, backgroundColor: `color-mix(in oklab, ${hl} 8%, transparent)` } : undefined}
                    >
                      <div className="flex shrink-0 items-center gap-2">
                        <span className="shrink-0 text-muted-foreground tabular-nums">{formatClock(log.time)}</span>
                        <span className={cn('shrink-0 font-semibold sm:w-14', levelClass[log.level])}>{log.level.toUpperCase()}</span>
                        <span className="min-w-0 truncate text-muted-foreground sm:w-28">[{log.scope}]</span>
                        {log.req !== undefined && (
                          <span className="shrink-0 rounded bg-primary/10 px-1 text-[10px] text-primary tabular-nums" title="请求关联号">#{log.req}</span>
                        )}
                      </div>
                      <span className={cn('min-w-0', prefs.wrap ? 'whitespace-pre-wrap break-all' : 'truncate')} title={prefs.wrap ? undefined : log.message}>
                        {log.message}
                      </span>
                    </motion.div>
                  );
                })
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
