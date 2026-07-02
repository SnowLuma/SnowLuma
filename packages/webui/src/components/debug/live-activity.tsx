// LiveActivity — the merged live SSE of OneBot events + action calls across all
// accounts. Extracted from the debug page so it can stand alone as a console
// tab. Filter by kind, keyword-search, pause, clear, and export the buffer as
// JSON. Rows expand to a JsonTree of the full payload.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Activity, ChevronRight, Download, Pause, Play, RadioTower, Search, Trash2 } from 'lucide-react';
import { JsonTree } from '@/components/ui/json-tree';
import { Segmented } from '@/components/debug/segmented';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DebugStreamMessage } from '@/types';

const STREAM_CAP = 300;
const cardCls = 'rounded-2xl border border-border/60 bg-card/80 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.10)] backdrop-blur-sm';

interface StreamRow { id: number; at: number; msg: Extract<DebugStreamMessage, { kind: 'event' | 'action' | 'dropped' }>; search: string }

function IconBtn({ onClick, title, children }: { onClick: () => void; title: string; children: ReactNode }) {
  return (
    <button type="button" onClick={onClick} title={title} aria-label={title}
      className="flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground">
      {children}
    </button>
  );
}

function StatusPill({ status }: { status: 'open' | 'reconnecting' | 'closed' }) {
  const map = {
    open: { dot: 'bg-emerald-500', label: '已连接', glow: 'shadow-[0_0_0_3px_rgb(16_185_129/0.15)]' },
    reconnecting: { dot: 'bg-amber-500', label: '重连中', glow: 'shadow-[0_0_0_3px_rgb(245_158_11/0.15)]' },
    closed: { dot: 'bg-muted-foreground/50', label: '未连接', glow: '' },
  }[status];
  return (
    <div className="inline-flex items-center gap-2 rounded-full border border-border/60 bg-card/70 px-3 py-1.5 text-xs font-medium backdrop-blur-sm">
      <span className={cn('h-2 w-2 rounded-full', map.dot, map.glow)} />
      <span className="text-muted-foreground">{map.label}</span>
    </div>
  );
}

function rowLabel(msg: Extract<DebugStreamMessage, { kind: 'event' | 'action' }>): { label: string; detail: unknown; isAction: boolean; ok: boolean } {
  if (msg.kind === 'event') {
    const e = msg.event as Record<string, unknown>;
    return {
      label: `${e.post_type ?? 'event'}${e.message_type ? `.${e.message_type}` : e.notice_type ? `.${e.notice_type}` : ''}`,
      detail: e, isAction: false, ok: true,
    };
  }
  // action
  return {
    label: msg.action,
    detail: { params: msg.params, response: msg.response },
    isAction: true,
    ok: (msg.response as { status?: string }).status === 'ok',
  };
}

function StreamRowItem({ row }: { row: StreamRow }) {
  const [open, setOpen] = useState(false);
  const { msg } = row;
  const time = new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false });

  if (msg.kind === 'dropped') {
    return <div className="px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">因客户端过慢丢弃了 {msg.count} 条</div>;
  }

  const { label, detail, isAction, ok } = rowLabel(msg);
  return (
    <div className="group rounded-xl transition-colors hover:bg-muted/40">
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-[13px]" onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{time}</span>
        <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold', isAction ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>
          {isAction ? '调用' : '事件'}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">{msg.uin}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">{label}</span>
        {msg.kind === 'action' && (
          <span className={cn('shrink-0 text-[11px] tabular-nums', ok ? 'text-success' : 'text-destructive')}>
            {ok ? 'ok' : 'failed'} · {msg.ms}ms
          </span>
        )}
      </button>
      {open && <div className="mx-2.5 mb-2"><JsonTree data={detail} maxHeight="18rem" /></div>}
    </div>
  );
}

export function LiveActivity() {
  const api = useApi();
  const [rows, setRows] = useState<StreamRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<'open' | 'reconnecting' | 'closed'>('closed');
  const [kindFilter, setKindFilter] = useState<'all' | 'event' | 'action'>('all');
  const [query, setQuery] = useState('');
  const pausedRef = useRef(paused);
  useEffect(() => { pausedRef.current = paused; }, [paused]);
  const idRef = useRef(0);

  useEffect(() => {
    const off = api.debug.stream(
      (m) => {
        if (m.kind === 'ready' || pausedRef.current) return;
        setRows((prev) => {
          // Precompute the search haystack once at enqueue, so filtering never
          // re-stringifies every row on each keystroke.
          const next = [{ id: idRef.current++, at: Date.now(), msg: m, search: JSON.stringify(m).toLowerCase() }, ...prev];
          return next.length > STREAM_CAP ? next.slice(0, STREAM_CAP) : next;
        });
      },
      (s) => setStatus(s),
    );
    return off;
  }, [api]);

  const visible = useMemo(() => {
    const q = query.trim().toLowerCase();
    return rows.filter((r) => {
      if (kindFilter !== 'all' && r.msg.kind !== kindFilter) return false;
      if (!q) return true;
      if (r.msg.kind === 'dropped') return false;
      const { label } = rowLabel(r.msg);
      return label.toLowerCase().includes(q) || r.msg.uin.includes(q) || r.search.includes(q);
    });
  }, [rows, kindFilter, query]);

  const exportJson = () => {
    const blob = new Blob([JSON.stringify(visible.map((r) => ({ at: r.at, ...r.msg })), null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `debug-activity-${visible.length}.json`;
    document.body.appendChild(a);
    a.click();
    a.remove();
    // Revoke after the download has had a chance to start (immediate revoke
    // cancels it in some browsers).
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
      className={cn(cardCls, 'flex min-h-[28rem] flex-col p-6')}
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-2.5">
          <RadioTower className="h-[18px] w-[18px] text-primary" />
          <h2 className="text-[15px] font-semibold tracking-tight">实时活动</h2>
          <span className="text-xs text-muted-foreground tabular-nums">{visible.length}</span>
          <StatusPill status={status} />
        </div>
        <div className="flex items-center gap-2">
          <Segmented value={kindFilter} onChange={setKindFilter}
            options={[{ value: 'all', label: '全部' }, { value: 'event', label: '事件' }, { value: 'action', label: '调用' }]} />
          <IconBtn onClick={() => setPaused((v) => !v)} title={paused ? '继续' : '暂停'}>{paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}</IconBtn>
          <IconBtn onClick={exportJson} title="导出 JSON"><Download className="h-4 w-4" /></IconBtn>
          <IconBtn onClick={() => setRows([])} title="清空"><Trash2 className="h-4 w-4" /></IconBtn>
        </div>
      </div>

      <div className="mt-3 flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索类型 / 账号 / 内容…"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      </div>

      <div className="mt-3 flex flex-1 flex-col gap-1 overflow-auto">
        {visible.length === 0 ? (
          <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
            <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/60"><Activity className="h-6 w-6 text-muted-foreground/70" /></div>
            <p className="text-sm text-muted-foreground">{paused ? '已暂停' : query || kindFilter !== 'all' ? '无匹配' : '等待事件…'}</p>
          </div>
        ) : (
          visible.map((r) => <StreamRowItem key={r.id} row={r} />)
        )}
      </div>
    </motion.section>
  );
}
