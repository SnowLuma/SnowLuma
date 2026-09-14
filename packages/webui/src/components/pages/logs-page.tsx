import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { sanitizeLogLine } from '@snowluma/common/log-sanitize';
import { useVirtualizer } from '@tanstack/react-virtual';
import { motion, AnimatePresence } from 'motion/react';
import { ArrowDownToLine, Download, Filter, Highlighter, Inbox, Pause, Plus, RefreshCw, Search, SearchX, SlidersHorizontal, Trash2, TriangleAlert, WrapText, X } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { cn } from '@/lib/utils';
import type { LogEntry, LogLevel, LogsPreset, UiHighlightRule } from '@/types';
import { useApi } from '@/lib/api';
import {
  selectServerLogLevel,
  TRACE_CONFIRMATION_WARNINGS,
} from '@/lib/server-log-level';
import { useTheme } from '@/contexts/ThemeContext';
import { useLayout } from '@/contexts/LayoutContext';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';

// Dedicated log-level text tokens (see index.css): the app accent colors are
// too light as small text on the light canvas (WCAG AA fails), so these hit
// >=4.5:1 in light mode while keeping the bright values in dark. trace stays the
// faintest level (dimmer than debug) but at /90 it now also clears AA.
const levelClass: Record<LogLevel, string> = {
  trace: 'text-muted-foreground/90',
  debug: 'text-muted-foreground',
  info: 'text-log-info',
  success: 'text-log-success',
  warn: 'text-log-warn',
  error: 'text-log-error',
};

const LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'success', 'warn', 'error'];
// More than this many new lines in one flush ⇒ firehose: suppress the per-row
// entrance so a 100 line/s stream never strobes (scroll flow + edge fade carry it).
const BURST_MAX = 4;

// View presets bundle the display prefs (levels/maxLines/autoScroll/wrap). The
// server stores only the id; 'custom' (any hand-tuned state) has no bundle.
interface PresetBundle { visibleLevels: LogLevel[]; maxLines: number; autoScroll: boolean; wrap: boolean }
const LOG_PRESETS: { id: Exclude<LogsPreset, 'custom'>; label: string; hint: string; bundle: PresetBundle }[] = [
  { id: 'dev', label: '开发', hint: '全部级别 · 2000 行 · 换行', bundle: { visibleLevels: [...LEVELS], maxLines: 2000, autoScroll: true, wrap: true } },
  { id: 'ops', label: '运维', hint: 'INFO 以上 · 1000 行', bundle: { visibleLevels: ['info', 'success', 'warn', 'error'], maxLines: 1000, autoScroll: true, wrap: false } },
  { id: 'minimal', label: '精简', hint: '仅 WARN/ERROR · 500 行', bundle: { visibleLevels: ['warn', 'error'], maxLines: 500, autoScroll: true, wrap: false } },
];

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
  const { runAction } = useActionFeedback();
  const { formatClock, appearance } = useTheme();
  const { pages, setPages } = useLayout();
  const prefs = pages.logs;

  const [logs, setLogs] = useState<LogEntry[]>([]);
  const [logsReady, setLogsReady] = useState(false);
  const [logsError, setLogsError] = useState<string | null>(null);
  const [streamStatus, setStreamStatus] = useState('连接中');
  const [filter, setFilter] = useState('');
  const [confirmClear, setConfirmClear] = useState(false);
  const [serverLevel, setServerLevel] = useState<LogLevel | null>(null);
  const [serverLevelReady, setServerLevelReady] = useState(false);
  const [serverLevelError, setServerLevelError] = useState<string | null>(null);
  const [levelBusy, setLevelBusy] = useState(false);
  const [confirmTrace, setConfirmTrace] = useState(false);
  const [traceExportBusy, setTraceExportBusy] = useState(false);
  const [showOptions, setShowOptions] = useState(false);
  const [newKeyword, setNewKeyword] = useState('');
  const [newColor, setNewColor] = useState(HIGHLIGHT_COLORS[0].id);
  const scrollRef = useRef<HTMLDivElement | null>(null);
  // Ids currently playing the entrance animation. Populated in the flush (from
  // real arrivals, so it's immune to filter/idle churn) and pruned by a 260ms
  // timer so a later scroll-into-view never replays. Render reads it directly.
  const animatingRef = useRef<Set<number>>(new Set());
  const animTimersRef = useRef<Set<number>>(new Set());
  const motionOnRef = useRef(true); // live motion pref for the async flush closure

  // maxLines is read through a ref so changing it doesn't re-subscribe the SSE.
  const maxLines = prefs.maxLines;
  const maxLinesRef = useRef(maxLines);
  useEffect(() => { maxLinesRef.current = maxLines; }, [maxLines]);

  const enabled = useMemo(() => new Set(prefs.visibleLevels as LogLevel[]), [prefs.visibleLevels]);

  const loadLogs = useCallback(async () => {
    setLogsError(null);
    try {
      // Backfill is capped at the server's ring-buffer size (1000); `maxLines`
      // can exceed that, but only the live SSE stream grows the view past 1000.
      setLogs(await api.logs.list(Math.min(1000, maxLinesRef.current)));
    } catch (e) {
      console.error('logs', e);
      setLogsError(e instanceof Error ? e.message : '加载日志失败');
    } finally {
      setLogsReady(true);
    }
  }, [api]);

  useEffect(() => { void loadLogs(); }, [loadLogs]);

  const loadServerLevel = useCallback(async () => {
    setServerLevelReady(false);
    setServerLevelError(null);
    try {
      const { level } = await api.logs.getLevel();
      setServerLevel(level);
    } catch (error) {
      console.error('get server log level failed', error);
      setServerLevelError(error instanceof Error ? error.message : '加载服务端日志级别失败');
    } finally {
      setServerLevelReady(true);
    }
  }, [api]);

  useEffect(() => {
    void loadServerLevel();
  }, [loadServerLevel]);

  const applyServerLevel = useCallback(async (lv: LogLevel) => {
    if (lv === serverLevel || levelBusy) return;
    setLevelBusy(true);
    try {
      const { level } = await runAction(
        {
          title: '正在更新服务端日志级别',
          detail: `切换为 ${lv.toUpperCase()}`,
          successTitle: '日志级别已更新',
          successDetail: `${lv.toUpperCase()} 已生效`,
          errorTitle: '日志级别更新失败',
        },
        () => api.logs.setLevel(lv),
      );
      setServerLevel(level);
    } catch (err) {
      console.error('setLevel', err);
    } finally {
      setLevelBusy(false);
    }
  }, [api, serverLevel, levelBusy, runAction]);

  const changeServerLevel = useCallback((lv: LogLevel) => {
    if (levelBusy) return;
    selectServerLogLevel({
      currentLevel: serverLevel,
      nextLevel: lv,
      applyLevel: (level) => void applyServerLevel(level),
      requestTraceConfirmation: () => setConfirmTrace(true),
    });
  }, [applyServerLevel, levelBusy, serverLevel]);

  useEffect(() => {
    // Batch incoming lines: buffer in a ref and flush on a ~80ms timer instead
    // of a per-line setState. Under a high log rate this turns N O(n) array
    // copies + N React commits per window into one. Dedup-by-id and the
    // maxLines cap are preserved (a reconnect can replay recent ids).
    let pending: LogEntry[] = [];
    let flushTimer: number | null = null;
    // Stable Set instances — captured so cleanup clears the very sets the flush
    // mutates (satisfies the ref-in-cleanup lint without changing behaviour).
    const animating = animatingRef.current;
    const animTimers = animTimersRef.current;
    const flush = () => {
      flushTimer = null;
      if (pending.length === 0) return;
      const batchMap = new Map(pending.map((e) => [e.id, e] as const));
      pending = [];
      // Mark just-arrived lines for the entrance animation — but suppress a
      // firehose batch (> BURST_MAX) so 100 lines/s never strobes; the scroll
      // flow + edge fade carry it instead. Populating here (before setLogs)
      // means the very first paint of the row already has the class, and the
      // 260ms timer bounds it so a later scroll-into-view can't replay it.
      if (motionOnRef.current && batchMap.size > 0 && batchMap.size <= BURST_MAX) {
        for (const id of batchMap.keys()) {
          animatingRef.current.add(id);
          const t = window.setTimeout(() => {
            animatingRef.current.delete(id);
            animTimersRef.current.delete(t);
          }, 260);
          animTimersRef.current.add(t);
        }
      }
      setLogs((prev) => {
        const kept = prev.length ? prev.filter((it) => !batchMap.has(it.id)) : prev;
        const merged = kept.length ? [...kept, ...batchMap.values()] : [...batchMap.values()];
        return merged.length > maxLinesRef.current ? merged.slice(-maxLinesRef.current) : merged;
      });
    };
    const dispose = api.logs.stream({
      onLine: (entry) => {
        pending.push(entry);
        if (flushTimer == null) flushTimer = window.setTimeout(flush, 80);
      },
      onStatus: (s) => {
        if (s === 'open') setStreamStatus('实时');
        else if (s === 'reconnecting') setStreamStatus('重连中');
        else setStreamStatus('已断开');
      },
    });
    return () => {
      dispose();
      if (flushTimer != null) clearTimeout(flushTimer);
      for (const t of animTimers) clearTimeout(t);
      animTimers.clear();
      animating.clear();
    };
  }, [api]);

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

  // Virtualize the log rows: only the visible window (+overscan) is mounted, so
  // the DOM stays at a few dozen nodes regardless of how many lines the view
  // holds. Rows are dynamically measured (measureElement) so wrap mode's
  // variable-height lines are handled without a fixed row-height assumption.
  const rowVirtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 28,
    overscan: 12,
    // Key the size cache by row id, not index: the list is front-dropped at the
    // maxLines cap, so every surviving row's index shifts down each flush. Keying
    // by id keeps each measured height with its content (and matches the React
    // key), avoiding a one-frame height mis-attribution on off-screen rows.
    getItemKey: (index) => filtered[index]?.id ?? index,
  });

  // Toggling wrap changes every row's height — force a clean re-measure so the
  // cached sizes don't leave gaps/overlaps.
  useEffect(() => { rowVirtualizer.measure(); }, [prefs.wrap, rowVirtualizer]);

  // Follow the tail while auto-scroll is on. Re-run on anything that changes the
  // visible set or row heights (new logs, filter/level/maxLines → filtered.length,
  // wrap → heights), not just new logs. Freshly-appended rows still carry the
  // estimate on this pass, so a second pin on the next frame (after ResizeObserver
  // measures them) reaches the true bottom in wrap mode.
  useEffect(() => {
    if (!prefs.autoScroll || filtered.length === 0) return;
    const last = filtered.length - 1;
    rowVirtualizer.scrollToIndex(last, { align: 'end' });
    const raf = requestAnimationFrame(() => rowVirtualizer.scrollToIndex(last, { align: 'end' }));
    return () => cancelAnimationFrame(raf);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [logs, filtered.length, prefs.autoScroll, prefs.wrap]);

  // Entrance detection lives in the flush (real arrivals only). Here we just keep
  // the flush's motion read live, since it was captured once in the [api] effect.
  const motionOn = !appearance.reduceMotion && !appearance.disableMotion;
  useEffect(() => { motionOnRef.current = motionOn; }, [motionOn]);

  // Scroll-position-aware edge fade: fade a boundary only when hidden content
  // actually exists past it, so a fully-scrolled top/bottom row is never dimmed.
  const [edges, setEdges] = useState({ top: false, bottom: false });
  const recomputeEdges = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const top = el.scrollTop > 4; // small hysteresis so a 1px nudge can't flicker the fade
    const bottom = el.scrollTop + el.clientHeight < el.scrollHeight - 1;
    setEdges((p) => (p.top === top && p.bottom === bottom ? p : { top, bottom }));
  }, []);
  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    recomputeEdges();
    el.addEventListener('scroll', recomputeEdges, { passive: true });
    // A ResizeObserver on the viewport catches height changes the scroll/content
    // effects miss — e.g. the options panel expanding above the list, or a window
    // resize — in one listener.
    const ro = new ResizeObserver(() => recomputeEdges());
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', recomputeEdges);
      ro.disconnect();
    };
  }, [recomputeEdges]);
  // New lines / wrap changes shift the overflow, so recheck the edges then too.
  useEffect(() => { recomputeEdges(); }, [filtered.length, prefs.wrap, recomputeEdges]);
  const maskCls = appearance.disableMotion ? undefined
    : edges.top && edges.bottom ? 'log-fade-both'
      : edges.top ? 'log-fade-top'
        : edges.bottom ? 'log-fade-bottom'
          : undefined;

  // Any hand edit to the bundled prefs drops the active preset to 'custom'.
  const toggleLevel = (lv: LogLevel) => {
    const next = new Set(enabled);
    if (next.has(lv)) next.delete(lv); else next.add(lv);
    setPages({ logs: { ...prefs, visibleLevels: LEVELS.filter((l) => next.has(l)), preset: 'custom' } });
  };

  const clearFilters = useCallback(() => {
    setFilter('');
    setPages({ logs: { ...prefs, visibleLevels: [...LEVELS], preset: 'custom' } });
  }, [prefs, setPages]);

  const applyPreset = useCallback((p: typeof LOG_PRESETS[number]) => {
    setPages({ logs: { ...prefs, ...p.bundle, preset: p.id } });
  }, [prefs, setPages]);

  // Dump the current (filtered) view to a .log text file — purely client-side.
  const exportLogs = useCallback(() => {
    if (filtered.length === 0) return;
    const lines = filtered.map((l) => sanitizeLogLine(
      l.line || `${l.time} ${l.level.toUpperCase().padEnd(7)} [${l.scope}] ${l.message}`,
    ));
    const blob = new Blob([lines.join('\n') + '\n'], { type: 'text/plain;charset=utf-8' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    const ts = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
    a.href = url;
    a.download = `snowluma-logs-${ts}.log`;
    a.click();
    URL.revokeObjectURL(url);
  }, [filtered]);

  const exportFullTrace = useCallback(async () => {
    if (traceExportBusy) return;
    setTraceExportBusy(true);
    try {
      const { text, filename } = await runAction(
        {
          title: '正在导出完整 TRACE',
          detail: '正在读取服务端 TRACE 文件',
          successTitle: '完整 TRACE 已导出',
          errorTitle: 'TRACE 导出失败',
        },
        () => api.logs.exportTrace(),
      );
      const blob = new Blob([text], { type: 'text/plain;charset=utf-8' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.click();
      URL.revokeObjectURL(url);
    } catch (err) {
      console.error('exportTrace', err);
    } finally {
      setTraceExportBusy(false);
    }
  }, [api, traceExportBusy, runAction]);

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
              onClick={() => setPages({ logs: { ...prefs, autoScroll: !prefs.autoScroll, preset: 'custom' } })}
            >
              {prefs.autoScroll ? <ArrowDownToLine /> : <Pause />}
            </ToolButton>
            <ToolButton
              label="自动换行"
              active={prefs.wrap}
              onClick={() => setPages({ logs: { ...prefs, wrap: !prefs.wrap, preset: 'custom' } })}
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
          <ToolButton label="导出当前视图" onClick={exportLogs} disabled={filtered.length === 0}>
            <Download />
          </ToolButton>
          <ToolButton label="导出完整 TRACE" onClick={() => void exportFullTrace()} disabled={traceExportBusy}>
            <ArrowDownToLine />
          </ToolButton>
          <ToolButton label="清空视图" danger onClick={() => setConfirmClear(true)}>
            <Trash2 />
          </ToolButton>
        </div>
      </CardHeader>

      {serverLevel === 'trace' && (
        <div className="mx-5 mb-3 flex flex-wrap items-center justify-between gap-3 rounded-xl border border-destructive/40 bg-destructive/10 px-3 py-2.5 text-destructive">
          <div className="flex min-w-0 items-center gap-2">
            <TriangleAlert className="size-4 shrink-0" />
            <span className="text-xs font-semibold">TRACE 已开启：正在记录大量、可能未经脱敏的数据</span>
          </div>
          <Button
            variant="outline"
            size="sm"
            disabled={levelBusy}
            onClick={() => void applyServerLevel('info')}
            className="h-7 rounded-lg border-destructive/40 bg-card text-destructive hover:bg-destructive/10 hover:text-destructive"
          >
            恢复 INFO
          </Button>
        </div>
      )}

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
                  'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ease-out cursor-pointer',
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
              {/* View presets */}
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <SlidersHorizontal className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">视图预设</span>
                  <span className="text-xs text-muted-foreground">· 一键套用级别 / 行数 / 换行；手动调整后变为「自定义」</span>
                </div>
                <div className="inline-flex flex-wrap gap-1 rounded-lg bg-muted/60 p-1">
                  {LOG_PRESETS.map((p) => {
                    const active = prefs.preset === p.id;
                    return (
                      <button
                        key={p.id}
                        type="button"
                        onClick={() => applyPreset(p)}
                        aria-pressed={active}
                        title={p.hint}
                        className={cn(
                          'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-[background-color,color,box-shadow] duration-150 ease-out cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
                          active ? 'bg-card text-foreground shadow-sm ring-1 ring-border/60' : 'text-muted-foreground/70 hover:text-foreground',
                        )}
                      >
                        {p.label}
                      </button>
                    );
                  })}
                  <span
                    className={cn(
                      'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium',
                      prefs.preset === 'custom' ? 'bg-card text-foreground shadow-sm ring-1 ring-border/60' : 'text-muted-foreground/40',
                    )}
                  >
                    自定义
                  </span>
                </div>
              </div>

              {/* Server-side level */}
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <span className="text-xs font-medium text-foreground">服务端日志级别</span>
                  <span className="text-xs text-muted-foreground">· 普通日志仅影响控制台 / 实时流；首次登录凭据仅输出到启动终端；文件等级由环境变量决定，默认为 debug</span>
                </div>
                <SkeletonSwap
                  ready={serverLevelReady}
                  reserve={34}
                  lines={1}
                  lineHeight={34}
                  barHeight={8}
                  label="服务端日志级别"
                  className={serverLevelReady ? 'skeleton-swap-fluid min-h-[34px]' : 'w-72 max-w-full'}
                >
                  {serverLevelReady ? (
                    serverLevelError ? (
                      <div role="alert" className="flex flex-wrap items-center gap-2 text-xs text-destructive">
                        <span>{serverLevelError}</span>
                        <Button variant="outline" size="sm" onClick={() => void loadServerLevel()}>
                          重试
                        </Button>
                      </div>
                    ) : (
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
                                'inline-flex items-center gap-1.5 rounded-md px-2.5 py-1 text-xs font-medium transition-[background-color,color,box-shadow,opacity] duration-150 ease-out cursor-pointer disabled:cursor-not-allowed disabled:opacity-50',
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
                    )
                  ) : null}
                </SkeletonSwap>
              </div>

              {/* Highlight rules */}
              <div>
                <div className="mb-2 flex flex-wrap items-center gap-x-1.5 gap-y-0.5">
                  <Highlighter className="size-3.5 text-muted-foreground" />
                  <span className="text-xs font-medium text-foreground">高亮规则</span>
                  <span className="text-xs text-muted-foreground">· 命中关键词的行会被着色</span>
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
                      <span key={i} className="inline-flex items-center gap-1 rounded-full border px-2 py-0.5 text-meta" style={{ borderColor: colorSwatch(r.color) }}>
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
          {/* Column header lives OUTSIDE the scroll viewport so the virtualizer's
              scroll element contains only the rows (no sticky-offset math). */}
          {logsReady && filtered.length > 0 && (
            <div className="hidden items-center gap-3 border-b border-border/60 bg-card/60 px-3 py-2 font-mono text-micro font-medium uppercase tracking-wider text-muted-foreground/70 sm:flex">
              <span className="w-[104px] shrink-0">时间</span>
              <span className="w-[76px] shrink-0">级别</span>
              <span className="w-28 shrink-0">模块</span>
              <span className="flex-1">消息</span>
            </div>
          )}
          {logsReady && logsError && logs.length > 0 && (
            <div role="alert" className="border-b border-destructive/30 bg-destructive/10 px-3 py-2 text-xs text-destructive">
              {logsError}；当前显示已读取和实时接收的日志。
            </div>
          )}
          <ScrollArea viewportRef={scrollRef} className="min-h-0 flex-1" viewportClassName={cn('[&>div]:!block', maskCls)}>
            <SkeletonSwap
              ready={logsReady}
              reserve={240}
              lines={8}
              lineHeight={30}
              barHeight={10}
              label="运行日志"
              className={logsReady ? 'skeleton-swap-fluid min-h-60' : ''}
            >
              {logsReady ? (
                <div className="font-mono text-xs">
                  {logsError && logs.length === 0 ? (
                    <div role="alert" className="flex min-h-60 flex-col items-center justify-center gap-3 px-4 py-10 text-center font-sans text-destructive">
                      <TriangleAlert className="size-9 opacity-70" />
                      <span className="text-sm">{logsError}</span>
                      <Button variant="outline" size="sm" onClick={() => void loadLogs()} className="rounded-lg">
                        <RefreshCw className="size-3.5" /> 重试
                      </Button>
                    </div>
                  ) : filtered.length === 0 ? (
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
                    <div className="relative w-full" style={{ height: rowVirtualizer.getTotalSize() }}>
                      {rowVirtualizer.getVirtualItems().map((vRow) => {
                        const log = filtered[vRow.index];
                        if (!log) return null; // guard a transient count/measurement skew
                        const hl = matchHighlight(log.message, prefs.highlightRules);
                        // Entrance is decided entirely by animatingRef (populated in
                        // the flush from real arrivals, pruned at 260ms), so it fires
                        // on the first paint, never replays on scroll-into-view, and
                        // is immune to filter/idle churn. Outer = positioning +
                        // measurement (its translateY); inner = visual row + the
                        // transform-based entrance, kept separate so they never collide.
                        const entering = animatingRef.current.has(log.id);
                        return (
                          <div
                            key={log.id}
                            data-index={vRow.index}
                            ref={rowVirtualizer.measureElement}
                            className="absolute left-0 top-0 w-full"
                            style={{ transform: `translateY(${vRow.start}px)` }}
                          >
                            <div
                              className={cn(
                                'flex flex-col gap-0.5 border-b border-border/30 px-3 py-1.5 transition-colors hover:bg-accent/40 sm:flex-row sm:items-start sm:gap-3 sm:py-1',
                                entering && 'log-row-in',
                              )}
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
                                  <span className="mr-1.5 rounded bg-primary/10 px-1 text-micro text-primary tabular-nums" title="请求关联号">#{log.req}</span>
                                )}
                                {log.message}
                              </span>
                            </div>
                          </div>
                        );
                      })}
                    </div>
                  )}
                </div>
              ) : null}
            </SkeletonSwap>
          </ScrollArea>
        </div>
      </CardContent>

      <ConfirmDialog
        open={confirmTrace}
        onOpenChange={setConfirmTrace}
        title="开启 TRACE 日志？"
        description={(
          <div className="space-y-2">
            <p>开启前请确认：</p>
            <ul className="list-disc space-y-1 pl-5">
              {TRACE_CONFIRMATION_WARNINGS.map((warning) => (
                <li key={warning}>{warning}</li>
              ))}
            </ul>
          </div>
        )}
        confirmText="开启 TRACE"
        destructive
        onConfirm={() => applyServerLevel('trace')}
      />

      <ConfirmDialog
        open={confirmClear}
        onOpenChange={setConfirmClear}
        title="清空当前日志视图？"
        description="此操作仅清空浏览器视图中的日志，不会影响服务端的日志缓冲区。"
        confirmText="清空"
        destructive
        activity={{
          title: '正在清空日志视图',
          successTitle: '日志视图已清空',
          errorTitle: '日志视图清空失败',
        }}
        onConfirm={() => setLogs([])}
      />
    </Card>
  );
}
