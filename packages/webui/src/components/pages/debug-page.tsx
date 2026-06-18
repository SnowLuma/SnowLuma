// Debug — a standalone top-level page (Wave A3, redesigned). Apple-HIG flavour:
// clarity (calm type hierarchy, generous whitespace), deference (translucent
// chrome, content-first), depth (soft layered cards, a sliding segmented
// control). Two tools over /api/debug/*:
//   • Action 测试台 — pick account + action (schema form / raw JSON), invoke.
//   • 实时活动 — merged live SSE of events + action calls.
import { useEffect, useId, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Activity, Bug, ChevronRight, FlaskConical, Loader2, Pause, Play, RadioTower, Trash2 } from 'lucide-react';
import { Input } from '@/components/ui/input';
import { Select } from '@/components/ui/select';
import { Textarea } from '@/components/ui/textarea';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DebugActionDoc, DebugInvokeResult, DebugStreamMessage, QQInfo } from '@/types';

const STREAM_CAP = 300;

interface StreamRow { id: number; at: number; msg: Extract<DebugStreamMessage, { kind: 'event' | 'action' | 'dropped' }> }

function coerceParam(type: string, raw: string): unknown {
  if (raw === '') return undefined;
  if (type.includes('int') || type === 'number' || type === 'uint') {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === 'bool' || type === 'boolean') return raw === 'true' || raw === '1';
  return raw;
}

// ── iOS-style segmented control with a sliding active pill ──
function Segmented<T extends string>({ value, onChange, options }: {
  value: T; onChange: (v: T) => void; options: { value: T; label: ReactNode }[];
}) {
  const id = useId();
  return (
    <div role="radiogroup" className="inline-flex rounded-full bg-muted/70 p-0.5 text-sm">
      {options.map((o) => {
        const active = o.value === value;
        return (
          <button
            key={o.value}
            type="button"
            role="radio"
            aria-checked={active}
            onClick={() => onChange(o.value)}
            className={cn('relative rounded-full px-3.5 py-1 font-medium transition-colors',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground')}
          >
            {active && (
              <motion.span
                layoutId={`seg-${id}`}
                transition={{ type: 'spring', stiffness: 500, damping: 38 }}
                className="absolute inset-0 rounded-full bg-card shadow-sm ring-1 ring-border/50"
              />
            )}
            <span className="relative z-10">{o.label}</span>
          </button>
        );
      })}
    </div>
  );
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

const cardCls = 'rounded-2xl border border-border/60 bg-card/80 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.10)] backdrop-blur-sm';

export function DebugPage() {
  const api = useApi();

  // ── action tester ──
  const [accounts, setAccounts] = useState<QQInfo[]>([]);
  const [docs, setDocs] = useState<DebugActionDoc[]>([]);
  const [uin, setUin] = useState('');
  const [actionName, setActionName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [paramMode, setParamMode] = useState<'form' | 'json'>('form');
  const [rawJson, setRawJson] = useState('{}');
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<DebugInvokeResult | { error: string } | null>(null);

  const doc = useMemo(() => docs.find((d) => d.name === actionName), [docs, actionName]);
  const effectiveMode = paramMode === 'json' || !doc ? 'json' : 'form';

  useEffect(() => {
    void (async () => {
      try {
        const [qq, acts] = await Promise.all([api.qqList(), api.debug.actions()]);
        setAccounts(qq);
        setDocs(acts.actions);
        if (qq[0]) setUin(qq[0].uin);
      } catch { /* surfaced lazily on invoke */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const invoke = async () => {
    if (!uin) { setResult({ error: '请选择账号' }); return; }
    if (!actionName.trim()) { setResult({ error: '请填写 action' }); return; }
    let params: Record<string, unknown> = {};
    if (effectiveMode === 'json') {
      try { params = JSON.parse(rawJson || '{}'); } catch { setResult({ error: 'params JSON 无效' }); return; }
      if (typeof params !== 'object' || params === null || Array.isArray(params)) { setResult({ error: 'params 必须是对象' }); return; }
    } else if (doc) {
      for (const p of doc.params) {
        const v = coerceParam(p.type, fields[p.name] ?? '');
        if (v !== undefined) params[p.name] = v;
      }
    }
    setInvoking(true);
    setResult(null);
    try { setResult(await api.debug.invoke(uin, actionName.trim(), params)); }
    catch (e) { setResult({ error: e instanceof Error ? e.message : '调用失败' }); }
    finally { setInvoking(false); }
  };

  const resultFailed = !!result && ('error' in result || result.status === 'failed');

  // ── live stream ──
  const [rows, setRows] = useState<StreamRow[]>([]);
  const [paused, setPaused] = useState(false);
  const [status, setStatus] = useState<'open' | 'reconnecting' | 'closed'>('closed');
  const [kindFilter, setKindFilter] = useState<'all' | 'event' | 'action'>('all');
  const pausedRef = useRef(paused);
  pausedRef.current = paused;
  const idRef = useRef(0);

  useEffect(() => {
    const off = api.debug.stream(
      (m) => {
        if (m.kind === 'ready' || pausedRef.current) return;
        setRows((prev) => {
          const next = [{ id: idRef.current++, at: Date.now(), msg: m }, ...prev];
          return next.length > STREAM_CAP ? next.slice(0, STREAM_CAP) : next;
        });
      },
      (s) => setStatus(s),
    );
    return off;
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const visible = rows.filter((r) => kindFilter === 'all' || r.msg.kind === kindFilter);

  return (
    <div className="mx-auto flex max-w-6xl flex-col gap-6">
      {/* header */}
      <motion.header
        initial={{ opacity: 0, y: -6 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.3 }}
        className="sticky top-0 z-10 -mx-1 flex items-center justify-between gap-4 rounded-b-2xl bg-background/60 px-1 py-3 backdrop-blur-xl"
      >
        <div className="flex items-center gap-3">
          <div className="flex h-10 w-10 items-center justify-center rounded-2xl bg-primary/10 text-primary">
            <Bug className="h-5 w-5" />
          </div>
          <div>
            <h1 className="text-2xl font-semibold tracking-tight">调试</h1>
            <p className="text-sm text-muted-foreground">接口测试台与实时活动观测</p>
          </div>
        </div>
        <StatusPill status={status} />
      </motion.header>

      <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
        {/* tester */}
        <motion.section
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.05 }}
          className={cn(cardCls, 'flex flex-col gap-5 p-6 xl:col-span-5')}
        >
          <div className="flex items-center gap-2.5">
            <FlaskConical className="h-[18px] w-[18px] text-primary" />
            <h2 className="text-[15px] font-semibold tracking-tight">Action 测试台</h2>
          </div>
          <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
            <span>调用会<strong className="font-semibold">真实生效</strong>（真发消息 / 真踢人等），请谨慎。</span>
          </div>

          <div className="grid gap-4 sm:grid-cols-2">
            <Field label="账号">
              <Select value={uin} onChange={(e) => setUin(e.target.value)}>
                {accounts.length === 0 && <option value="">（无在线账号）</option>}
                {accounts.map((a) => <option key={a.uin} value={a.uin}>{a.nickname || a.uin}</option>)}
              </Select>
            </Field>
            <Field label="Action">
              <Input list="dbg-actions" value={actionName} placeholder="send_group_msg"
                onChange={(e) => { setActionName(e.target.value); setResult(null); }} />
              <datalist id="dbg-actions">
                {docs.map((d) => <option key={d.name} value={d.name}>{d.summary}</option>)}
              </datalist>
            </Field>
          </div>

          {doc && (
            <p className="-mt-1 text-[12px] text-muted-foreground">
              {doc.summary}{doc.returns ? <> · 返回 <code className="font-mono text-[11px]">{doc.returns}</code></> : null}
            </p>
          )}

          <div className="flex items-center justify-between">
            <span className="text-xs font-medium text-muted-foreground">参数</span>
            <Segmented
              value={effectiveMode}
              onChange={(m) => setParamMode(m)}
              options={[{ value: 'form', label: '表单' }, { value: 'json', label: 'JSON' }]}
            />
          </div>

          {effectiveMode === 'json' ? (
            <Textarea className="min-h-28 rounded-xl font-mono text-xs" value={rawJson}
              onChange={(e) => setRawJson(e.target.value)} placeholder='{ "group_id": 12345, "message": "hi" }' />
          ) : (
            <div className="flex flex-col gap-3">
              {doc!.params.length === 0 && <p className="text-[12px] text-muted-foreground">该接口无参数。</p>}
              {doc!.params.map((p) => (
                <Field key={p.name} label={<>{p.name}<span className="ml-1 font-normal text-muted-foreground/70">{p.type}{p.required ? ' · 必填' : ''}</span></>}>
                  <Input value={fields[p.name] ?? ''}
                    onChange={(e) => setFields((f) => ({ ...f, [p.name]: e.target.value }))}
                    placeholder={p.desc || (p.default !== undefined ? `默认 ${JSON.stringify(p.default)}` : '')} />
                </Field>
              ))}
            </div>
          )}

          <button type="button" onClick={invoke} disabled={invoking}
            className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary text-[15px] font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.99] disabled:opacity-50">
            {invoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} 执行
          </button>

          {result && (
            <div className="flex flex-col gap-1.5">
              <span className={cn('text-xs font-medium', resultFailed ? 'text-destructive' : 'text-success')}>
                {resultFailed ? '失败' : '成功'}
              </span>
              <pre className={cn('max-h-72 overflow-auto rounded-xl border border-border/60 bg-muted/30 p-4 font-mono text-[11.5px] leading-relaxed',
                resultFailed && 'text-destructive')}>
                {JSON.stringify(result, null, 2)}
              </pre>
            </div>
          )}
        </motion.section>

        {/* live stream */}
        <motion.section
          initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.1 }}
          className={cn(cardCls, 'flex min-h-[28rem] flex-col p-6 xl:col-span-7')}
        >
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-2.5">
              <RadioTower className="h-[18px] w-[18px] text-primary" />
              <h2 className="text-[15px] font-semibold tracking-tight">实时活动</h2>
              <span className="text-xs text-muted-foreground tabular-nums">{visible.length}</span>
            </div>
            <div className="flex items-center gap-2">
              <Segmented
                value={kindFilter}
                onChange={setKindFilter}
                options={[{ value: 'all', label: '全部' }, { value: 'event', label: '事件' }, { value: 'action', label: '调用' }]}
              />
              <IconBtn onClick={() => setPaused((v) => !v)} title={paused ? '继续' : '暂停'}>
                {paused ? <Play className="h-4 w-4" /> : <Pause className="h-4 w-4" />}
              </IconBtn>
              <IconBtn onClick={() => setRows([])} title="清空"><Trash2 className="h-4 w-4" /></IconBtn>
            </div>
          </div>

          <div className="mt-4 flex flex-1 flex-col gap-1 overflow-auto">
            {visible.length === 0 ? (
              <div className="flex flex-1 flex-col items-center justify-center gap-3 py-12 text-center">
                <div className="flex h-14 w-14 items-center justify-center rounded-2xl bg-muted/60">
                  <Activity className="h-6 w-6 text-muted-foreground/70" />
                </div>
                <p className="text-sm text-muted-foreground">{paused ? '已暂停' : '等待事件…'}</p>
              </div>
            ) : (
              visible.map((r) => <StreamRowItem key={r.id} row={r} />)
            )}
          </div>
        </motion.section>
      </div>
    </div>
  );
}

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

function StreamRowItem({ row }: { row: StreamRow }) {
  const [open, setOpen] = useState(false);
  const { msg } = row;
  const time = new Date(row.at).toLocaleTimeString('zh-CN', { hour12: false });

  if (msg.kind === 'dropped') {
    return <div className="px-2 py-1.5 text-[11px] text-amber-600 dark:text-amber-400">因客户端过慢丢弃了 {msg.count} 条</div>;
  }

  const isAction = msg.kind === 'action';
  let label: string;
  let detail: unknown;
  let ok = true;
  if (msg.kind === 'event') {
    const e = msg.event as Record<string, unknown>;
    label = `${e.post_type ?? 'event'}${e.message_type ? `.${e.message_type}` : e.notice_type ? `.${e.notice_type}` : ''}`;
    detail = e;
  } else {
    ok = (msg.response as { status?: string }).status === 'ok';
    label = msg.action;
    detail = { params: msg.params, response: msg.response };
  }

  return (
    <div className="group rounded-xl transition-colors hover:bg-muted/40">
      <button type="button" aria-expanded={open} className="flex w-full items-center gap-2.5 px-2.5 py-2 text-left text-[13px]" onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{time}</span>
        <span className={cn('shrink-0 rounded-md px-1.5 py-0.5 text-[10px] font-semibold',
          isAction ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>
          {isAction ? '调用' : '事件'}
        </span>
        <span className="shrink-0 font-mono text-[11px] text-muted-foreground/80">{msg.uin}</span>
        <span className="min-w-0 flex-1 truncate font-mono text-foreground/90">{label}</span>
        {isAction && (
          <span className={cn('shrink-0 text-[11px] tabular-nums', ok ? 'text-success' : 'text-destructive')}>
            {ok ? 'ok' : 'failed'} · {msg.ms}ms
          </span>
        )}
      </button>
      {open && (
        <pre className="mx-2.5 mb-2 max-h-72 overflow-auto rounded-lg bg-muted/40 p-3 font-mono text-[11px] leading-relaxed">
          {JSON.stringify(detail, null, 2)}
        </pre>
      )}
    </div>
  );
}
