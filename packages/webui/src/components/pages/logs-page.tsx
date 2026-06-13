import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDownToLine, Filter, Highlighter, Inbox, Pause, Plus, RefreshCw, Search, SearchX, SlidersHorizontal, Trash2, WrapText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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

// Apple-style toolbar icon button: icon-only, tooltip-labelled, calm hover.
interface ToolButtonProps {
  label: string;
  onClick: () => void;
  children: ReactNode;
  active?: boolean;
  danger?: boolean;
  disabled?: boolean;
}
function ToolButton({ label, onClick, children, active, danger, disabled }: ToolButtonProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={onClick}
          disabled={disabled}
          aria-label={label}
          aria-pressed={active}
          className={cn(
            'inline-flex size-8 items-center justify-center rounded-lg transition-colors cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed disabled:opacity-50 [&_svg]:size-4',
            active ? 'bg-primary/10 text-primary' : 'text-muted-foreground hover:bg-accent hover:text-foreground',
            danger && !active && 'hover:bg-destructive/10 hover:text-destructive',
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  );
}

export function LogsPage() {
  const api = useApi();
  const { formatClock, appearance } = useTheme();
  const { pages, setPages } = useLayout();
  const prefs = pages.logs;

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [streamStatus, setStreamStatus] = useState('连接中');
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [serverLevel, setServerLevel] = useState<LogLevel | null>(null);
  const [levelBusy, setLevelBusy] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
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

  const clearFilters = useCallback(() => {
    setFilter('');
    setPages({ logs: { ...prefs, visibleLevels: [...LEVELS] } });
  }, [prefs, setPages]);

  const addHighlight = () => {
    const kw = newKeyword.trim();
    if (!kw) return;
    setPages({ logs: { ...prefs, highlightRules: [...prefs.highlightRules, { keyword: kw, color: newColor }].slice(0, 20) } });
    setNewKeyword('');
  };
  const removeHighlight = (idx: number) => {
    setPages({ logs: { ...prefs, highlightRules: prefs.highlightRules.filter((_, i) => i !== idx) } });
  };

  const live = streamStatus === '实时';
  const connecting = streamStatus === '连接中' || streamStatus === '重连中';
  const levelsFiltered = enabled.size < LEVELS.length;

  return (
    <Card className="flex h-[calc(100vh-7rem)] min-h-[480px] flex-col overflow-hidden">
      {/* ── Toolbar ─────────────────────────────────────────────── */}
      <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
        <div className="flex min-w-0 flex-col gap-1">
          <div className="flex items-center gap-2.5">
            <CardTitle>运行日志</CardTitle>
            <span className="inline-flex items-center gap-1.5 text-xs font-medium">
              <span
                className={cn(
                  'size-1.5 rounded-full',
                  live ? 'bg-success animate-pulse' : connecting ? 'bg-warning' : 'bg-destructive',
                )}
              />
              <span className={cn(live ? 'text-success' : connecting ? 'text-warning' : 'text-destructive')}>
                {streamStatus}
              </span>
            </span>
          </div>
          <CardDescription className="text-xs">
            {filtered.length}/{logs.length} 条 · SSE 实时推送
            {serverLevel && (
              <>
                {' · 服务端 '}
                <span className={cn('font-medium', levelClass[serverLevel])}>{serverLevel.toUpperCase()}</span>
              </>
            )}
          </CardDescription>
        </div>

        <div className="flex flex-wrap items-center gap-1.5 sm:justify-end">
          <div className="relative">
            <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
            <Input
              placeholder="搜索消息 / 模块 / 级别"
              value={filter}
              onChange={(e) => setFilter(e.target.value)}
              className="h-8 w-44 rounded-lg pl-8 pr-7 sm:w-56"
            />
            {filter && (
              <button
                type="button"
                onClick={() => setFilter('')}
                aria-label="清除搜索"
                className="absolute right-1.5 top-1/2 -translate-y-1/2 rounded-full p-0.5 text-muted-foreground outline-none transition-colors hover:text-foreground focus-visible:ring-[3px] focus-visible:ring-ring/40 cursor-pointer"
              >
                <X className="size-3.5" />
              </button>
            )}
          </div>

          <div className="flex items-center gap-0.5 rounded-lg bg-muted/40 p-0.5">
            <ToolButton
              label={prefs.autoScroll ? '自动滚动已开启' : '自动滚动已暂停'}
              active={prefs.autoScroll}
              onClick={() => setPages({ logs: { ...prefs, autoScroll: !prefs.autoScroll } })}
            >
              {prefs.autoScroll ? <ArrowDownToLine /> : <Pause />}
            </ToolButton>
            <ToolButton
              label="自动换行"
              active={prefs.wrap}
              onClick={() => setPages({ logs: { ...prefs, wrap: !prefs.wrap } })}
            >
              <WrapText />
            </ToolButton>
            <ToolButton label="显示选项" active={showOptions} onClick={() => setShowOptions((v) => !v)}>
              <SlidersHorizontal />
            </ToolButton>
          </div>

          <span className="mx-0.5 h-5 w-px bg-border/70" />

          <ToolButton label="刷新" onClick={() => void loadLogs()}>
            <RefreshCw />
          </ToolButton>
          <ToolButton label="清空视图" danger onClick={() => setConfirmClear(true)}>
            <Trash2 />
          </ToolButton>
        </div>
      </CardHeader>

      {/* ── Level filter (segmented, always visible) ────────────── */}
      <div className="flex items-center gap-2 px-5 pb-3">
        <Filter className={cn('size-3.5 shrink-0', levelsFiltered ? 'text-primary' : 'text-muted-foreground/60')} />
        <div className="flex flex-wrap items-center gap-1 rounded-lg bg-muted/50 p-1">
          {LEVELS.map((lv) => {
            const active = enabled.has(lv);
            return (
              <button
                key={lv}
                type="button"
                onClick={() => toggleLevel(lv)}
                aria-pressed={active}
                className={cn(
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all cursor-pointer',
                  active
                    ? cn('bg-card shadow-sm ring-1 ring-border/60', levelClass[lv])
                    : 'text-muted-foreground/55 hover:text-foreground',
                )}
              >
                <span className={cn('size-1.5 rounded-full', active ? 'bg-current' : 'bg-muted-foreground/30')} />
                {lv.toUpperCase()}
              </button>
            );
          })}
        </div>
      </div>

      {/* ── Options panel (progressive disclosure) ──────────────── */}
      <AnimatePresence initial={false}>
        {showOptions && (
          <motion.div
            key="options"
            initial={{ height: 0, opacity: 0 }}
            animate={{ height: 'auto', opacity: 1 }}
            exit={{ height: 0, opacity: 0 }}
            transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
            className="overflow-hidden"
          >
            <div className="mx-5 mb-3 flex flex-col gap-4 rounded-xl border bg-muted/20 p-4">
              {/* Server-side level */}
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="text-xs font-medium text-foreground">服务端日志级别</span>
                  <span className="text-[10px] text-muted-foreground">· 仅影响控制台 / 实时流，文件始终落盘 debug</span>
                </div>
                <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
                  {LEVELS.map((lv) => {
                    const active = serverLevel === lv;
                    return (
                      <button
                        key={lv}
                        type="button"
                        onClick={() => void changeServerLevel(lv)}
                        disabled={levelBusy || serverLevel === null}
                        aria-pressed={active}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-[11px] font-medium transition-all cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
                          active
                            ? cn('bg-card shadow-sm ring-1 ring-border/60', levelClass[lv])
                            : 'text-muted-foreground/70 hover:text-foreground',
                        )}
                      >
                        <span className={cn('size-1.5 rounded-full', active ? 'bg-current' : 'bg-muted-foreground/30')} />
                        {lv.toUpperCase()}
                      </button>
                    );
                  })}
                </div>
              </div>

              {/* Highlight rules */}
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <Highlighter className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">高亮规则</span>
                  <span className="text-[10px] text-muted-foreground">· 命中关键词的行会被着色</span>
                </div>
                <div className="flex flex-wrap items-center gap-2">
                  <Input
                    placeholder="高亮关键词"
                    value={newKeyword}
                    maxLength={50}
                    onChange={(e) => setNewKeyword(e.target.value)}
                    onKeyDown={(e) => { if (e.key === 'Enter') addHighlight(); }}
                    className="h-8 w-44 rounded-lg"
                  />
                  <div className="flex items-center gap-1" role="radiogroup" aria-label="高亮颜色">
                    {HIGHLIGHT_COLORS.map((c) => (
                      <button
                        key={c.id}
                        type="button"
                        role="radio"
                        aria-checked={newColor === c.id}
                        onClick={() => setNewColor(c.id)}
                        title={c.label}
                        aria-label={c.label}
                        className={cn(
                          'size-6 rounded-full border transition-transform hover:scale-110 cursor-pointer',
                          newColor === c.id ? 'ring-2 ring-offset-1 ring-foreground/40' : 'border-border',
                        )}
                        style={{ backgroundColor: c.swatch }}
                      />
                    ))}
                  </div>
                  <Button variant="outline" size="sm" onClick={addHighlight} disabled={!newKeyword.trim()} className="rounded-lg">
                    <Plus className="size-3.5" /> 添加
                  </Button>
                </div>
                {prefs.highlightRules.length > 0 && (
                  <div className="mt-2.5 flex flex-wrap gap-1.5">
                    {prefs.highlightRules.map((r, i) => (
                      <span key={i} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-[11px]" style={{ borderColor: colorSwatch(r.color) }}>
                        <span className="size-2 rounded-full" style={{ backgroundColor: colorSwatch(r.color) }} />
                        {r.keyword}
                        <button type="button" onClick={() => removeHighlight(i)} className="text-muted-foreground hover:text-destructive cursor-pointer" aria-label={`移除高亮规则 ${r.keyword}`}>
                          <X className="size-3" />
                        </button>
                      </span>
                    ))}
                  </div>
                )}
              </div>
            </div>
          </motion.div>
        )}
      </AnimatePresence>

      {/* ── Log stream ──────────────────────────────────────────── */}
      <CardContent className="flex min-h-0 flex-1 flex-col pt-0">
        <div className="flex min-h-0 flex-1 flex-col overflow-hidden rounded-xl border bg-muted/20">
          <ScrollArea className="min-h-0 flex-1" viewportClassName="[&>div]:!block">
            <div className="font-mono text-xs">
              {filtered.length > 0 && (
                <div className="sticky top-0 z-10 hidden items-center gap-3 border-b border-border/60 bg-card/75 px-3 py-2 text-[10px] font-medium uppercase tracking-wider text-muted-foreground/70 backdrop-blur-md sm:flex">
                  <span className="w-[104px] shrink-0">时间</span>
                  <span className="w-[76px] shrink-0">级别</span>
                  <span className="w-28 shrink-0">模块</span>
                  <span className="flex-1">消息</span>
                </div>
              )}

              {filtered.length === 0 ? (
                <div className="flex min-h-60 flex-col items-center justify-center gap-3 px-4 py-10 text-center font-sans text-muted-foreground">
                  {logs.length === 0 ? (
                    <>
                      <Inbox className="size-9 opacity-30" />
                      <span className="text-sm">暂无日志</span>
                    </>
                  ) : (
                    <>
                      <SearchX className="size-9 opacity-30" />
                      <span className="text-sm">没有符合筛选条件的日志</span>
                      <Button variant="outline" size="sm" onClick={clearFilters} className="rounded-lg">清除筛选</Button>
                    </>
                  )}
                </div>
              ) : (
                <div className="divide-y divide-border/30">
                  {filtered.map((log) => {
                    const hl = matchHighlight(log.message, prefs.highlightRules);
                    return (
                      <motion.div
                        key={log.id}
                        initial={appearance.disableMotion ? false : { opacity: 0 }}
                        animate={{ opacity: 1 }}
                        transition={appearance.disableMotion ? { duration: 0 } : { duration: 0.12 }}
                        className="flex flex-col gap-0.5 px-3 py-1.5 transition-colors hover:bg-accent/40 sm:flex-row sm:items-start sm:gap-3 sm:py-1"
                        style={hl ? { boxShadow: `inset 3px 0 0 ${hl}`, backgroundColor: `color-mix(in oklab, ${hl} 8%, transparent)` } : undefined}
                      >
                        <div className="flex items-center gap-3 sm:contents">
                          <span className="w-[104px] shrink-0 tabular-nums text-muted-foreground">{formatClock(log.time)}</span>
                          <span className={cn('flex w-[76px] shrink-0 items-center gap-1.5 font-semibold', levelClass[log.level])}>
                            <span className="size-1.5 shrink-0 rounded-full bg-current" />
                            {log.level.toUpperCase()}
                          </span>
                          <span className="min-w-0 flex-1 truncate text-muted-foreground sm:w-28 sm:flex-none sm:shrink-0">[{log.scope}]</span>
                        </div>
                        <span
                          className={cn('min-w-0 flex-1 leading-5', prefs.wrap ? 'whitespace-pre-wrap break-all' : 'truncate')}
                          title={prefs.wrap ? undefined : log.message}
                        >
                          {log.req !== undefined && (
                            <span className="mr-1.5 rounded bg-primary/10 px-1 text-[10px] text-primary tabular-nums" title="请求关联号">#{log.req}</span>
                          )}
                          {log.message}
                        </span>
                      </motion.div>
                    );
                  })}
                </div>
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
