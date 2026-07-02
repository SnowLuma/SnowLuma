// ActionTester — the debug console's centrepiece. Pick an account + action and
// invoke it; params render as role-driven smart controls (pickers, switches,
// file sources) with a raw-JSON escape hatch. Read-only actions are badged
// green, side-effecting ones amber; destructive ones confirm first. Stream API
// actions invoke over the streaming transport and render frames live (tracked
// in the app-level task registry). Every call lands in localStorage history
// with one-click replay. Responses render in a collapsible JsonTree.
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { AlertTriangle, FlaskConical, History, Loader2, Play, RotateCcw, ShieldCheck, Trash2, Zap } from 'lucide-react';
import { Textarea } from '@/components/ui/textarea';
import { Picker } from '@/components/ui/picker';
import { JsonTree } from '@/components/ui/json-tree';
import { ParamField } from '@/components/debug/param-field';
import { Segmented } from '@/components/debug/segmented';
import { useApi } from '@/lib/api';
import { useDebugTasks } from '@/contexts/DebugTaskContext';
import { clearHistory, loadHistory, pushHistory, type InvokeRecord } from '@/lib/debug-history';
import { cn } from '@/lib/utils';
import type { DebugActionDoc, DebugStreamFrame, QQInfo } from '@/types';

const cardCls = 'rounded-2xl border border-border/60 bg-card/80 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.10)] backdrop-blur-sm';

// Name patterns for genuinely destructive actions → require a confirm. False
// positives just add one extra click; false negatives skip a confirm — both low
// stakes (the amber banner already warns that any write is real).
const DESTRUCTIVE_RE = /(kick|ban|mute|recall|withdraw|delete|del_|dismiss|disband|leave|quit|remove|revoke)/i;
// Cap retained stream frames so a long-running / runaway stream can't grow the
// array and DOM without bound. Generous enough to keep a full normal stream.
const MAX_STREAM_FRAMES = 2000;

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

function coerceParam(type: string, raw: string): unknown {
  if (raw === '') return undefined;
  if (/int|uint|number|messageId/i.test(type)) {
    const n = Number(raw);
    return Number.isFinite(n) ? n : raw;
  }
  if (type === 'bool' || type === 'boolean') return raw === 'true' || raw === '1';
  if (type === 'message') {
    const t = raw.trim();
    if ((t.startsWith('[') && t.endsWith(']')) || (t.startsWith('{') && t.endsWith('}'))) {
      try { return JSON.parse(t); } catch { /* fall through to literal */ }
    }
    return raw;
  }
  return raw;
}

function Field({ label, children }: { label: ReactNode; children: ReactNode }) {
  return (
    <label className="flex flex-col gap-1.5">
      <span className="text-xs font-medium text-muted-foreground">{label}</span>
      {children}
    </label>
  );
}

export function ActionTester({ accounts, docs, presetAction }: { accounts: QQInfo[]; docs: DebugActionDoc[]; presetAction?: { name: string; nonce: number } }) {
  const api = useApi();
  const tasks = useDebugTasks();

  const [uin, setUin] = useState('');
  const [actionName, setActionName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [paramMode, setParamMode] = useState<'form' | 'json'>('form');
  const [rawJson, setRawJson] = useState('{}');
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<DebugStreamFrame | { error: string } | null>(null);
  const [frames, setFrames] = useState<DebugStreamFrame[]>([]);
  const [confirmOpen, setConfirmOpen] = useState(false);
  const [history, setHistory] = useState<InvokeRecord[]>([]);
  const [showHistory, setShowHistory] = useState(false);
  const streamAbort = useRef<AbortController | null>(null);

  useEffect(() => { setHistory(loadHistory()); }, []);
  useEffect(() => { if (accounts[0] && !uin) setUin(accounts[0].uin); }, [accounts, uin]);
  // Prefill from the API browser's 试一下 (nonce lets the same action re-trigger).
  useEffect(() => {
    if (presetAction) { setActionName(presetAction.name); setParamMode('form'); setResult(null); setFrames([]); setShowHistory(false); }
  }, [presetAction]);

  const doc = useMemo(() => docs.find((d) => d.name === actionName), [docs, actionName]);
  const effectiveMode = paramMode === 'json' || !doc ? 'json' : 'form';
  const isStream = !!doc?.stream;
  const isDestructive = DESTRUCTIVE_RE.test(actionName);

  const accountOptions = useMemo(
    () => accounts.length === 0
      ? [{ value: '', label: '(无在线账号)' }]
      : accounts.map((a) => ({
          value: a.uin,
          label: a.nickname || a.uin,
          sub: a.nickname ? a.uin : undefined,
          avatar: qqAvatarUrl(a.uin),
        })),
    [accounts],
  );

  const actionOptions = useMemo(
    () => docs.map((d) => ({ value: d.name, label: d.name, sub: d.summary })),
    [docs],
  );

  const buildParams = (): Record<string, unknown> | { __error: string } => {
    if (effectiveMode === 'json') {
      let parsed: unknown;
      try { parsed = JSON.parse(rawJson || '{}'); } catch { return { __error: 'params JSON 无效' }; }
      if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) return { __error: 'params 必须是对象' };
      return parsed as Record<string, unknown>;
    }
    const out: Record<string, unknown> = {};
    if (doc) for (const p of doc.params) {
      const v = coerceParam(p.type, fields[p.name] ?? '');
      if (v !== undefined) out[p.name] = v;
    }
    return out;
  };

  const runInvoke = async () => {
    if (!uin) { setResult({ error: '请选择账号' }); return; }
    if (!actionName.trim()) { setResult({ error: '请填写 action' }); return; }
    const params = buildParams();
    if ('__error' in params) { setResult({ error: params.__error as string }); return; }

    setInvoking(true);
    setResult(null);
    setFrames([]);
    const startedAt = Date.now();

    if (isStream) {
      const ac = new AbortController();
      streamAbort.current = ac;
      const taskId = tasks.start({ kind: 'stream', label: `${actionName} @ ${uin}`, progress: undefined, cancel: () => ac.abort() });
      let last: DebugStreamFrame | null = null;
      try {
        await api.debug.invokeStream(uin, actionName.trim(), params, (frame) => {
          last = frame;
          setFrames((prev) => (prev.length >= MAX_STREAM_FRAMES ? [...prev.slice(-(MAX_STREAM_FRAMES - 1)), frame] : [...prev, frame]));
          const d = frame.data as { type?: string; progress?: number; transferred?: number; total?: number } | undefined;
          if (d && typeof d.progress === 'number') tasks.update(taskId, { progress: d.progress });
          else if (d && typeof d.transferred === 'number' && typeof d.total === 'number' && d.total > 0) tasks.update(taskId, { progress: d.transferred / d.total });
        }, ac.signal);
        // A clean success requires the terminal frame (status ok AND the
        // NapCat terminal marker data.type==='response') — a stream that closed
        // without emitting its terminator must not read as success.
        const term = last as DebugStreamFrame | null;
        const ok = !!term && term.status === 'ok' && (term.data as { type?: string } | undefined)?.type === 'response';
        setResult(last);
        tasks.finish(taskId, ok ? 'done' : 'failed');
        setHistory(pushHistory({ at: startedAt, uin, action: actionName.trim(), params, ok, ms: Date.now() - startedAt, stream: true }));
      } catch (e) {
        const aborted = ac.signal.aborted;
        const msg = e instanceof Error ? e.message : '流式调用失败';
        if (!aborted) setResult({ error: msg });
        tasks.finish(taskId, aborted ? 'canceled' : 'failed', msg);
        setHistory(pushHistory({ at: startedAt, uin, action: actionName.trim(), params, ok: false, ms: Date.now() - startedAt, stream: true }));
      } finally {
        streamAbort.current = null;
        setInvoking(false);
      }
      return;
    }

    try {
      const res = await api.debug.invoke(uin, actionName.trim(), params);
      setResult(res);
      setHistory(pushHistory({ at: startedAt, uin, action: actionName.trim(), params, ok: res.status === 'ok', ms: Date.now() - startedAt }));
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : '调用失败' });
      setHistory(pushHistory({ at: startedAt, uin, action: actionName.trim(), params, ok: false, ms: Date.now() - startedAt }));
    } finally {
      setInvoking(false);
    }
  };

  const onExecute = () => {
    if (isDestructive) { setConfirmOpen(true); return; }
    void runInvoke();
  };

  const replay = (rec: InvokeRecord) => {
    setUin(rec.uin);
    setActionName(rec.action);
    setParamMode('json');
    setRawJson(JSON.stringify(rec.params, null, 2));
    setResult(null);
    setFrames([]);
    setShowHistory(false);
  };

  const resultFailed = !!result && ('error' in result || result.status === 'failed');

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
      {/* tester */}
      <motion.section
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
        className={cn(cardCls, 'flex flex-col gap-5 p-6 xl:col-span-7')}
      >
        <div className="flex items-center justify-between gap-2">
          <div className="flex items-center gap-2.5">
            <FlaskConical className="h-[18px] w-[18px] text-primary" />
            <h2 className="text-[15px] font-semibold tracking-tight">Action 测试台</h2>
          </div>
          <button type="button" onClick={() => setShowHistory((v) => !v)}
            className="inline-flex items-center gap-1.5 rounded-lg px-2 py-1 text-xs text-muted-foreground hover:bg-muted hover:text-foreground">
            <History className="h-3.5 w-3.5" /> 历史 {history.length > 0 && <span className="tabular-nums">{history.length}</span>}
          </button>
        </div>

        <div className="flex items-start gap-2 rounded-xl bg-amber-500/10 px-3 py-2 text-[12px] leading-relaxed text-amber-700 dark:text-amber-300">
          <AlertTriangle className="mt-0.5 h-3.5 w-3.5 shrink-0" />
          <span>调用会<strong className="font-semibold">真实生效</strong>(真发消息 / 真踢人等),请谨慎。</span>
        </div>

        <div className="grid gap-4 sm:grid-cols-2">
          <Field label="账号">
            <Picker
              ariaLabel="选择账号"
              value={uin}
              onChange={setUin}
              options={accountOptions}
              placeholder="选择账号…"
              validateRaw={() => false}
              disabled={accounts.length === 0}
            />
          </Field>
          <Field label="Action">
            <Picker
              ariaLabel="选择 action"
              value={actionName}
              onChange={(v) => { setActionName(v); setResult(null); setFrames([]); }}
              options={actionOptions}
              placeholder="search action…"
              validateRaw={(s) => s.trim().length > 0}
            />
          </Field>
        </div>

        {doc && (
          <div className="-mt-1 flex flex-wrap items-center gap-2 text-[12px] text-muted-foreground">
            {doc.readOnly
              ? <span className="inline-flex items-center gap-1 rounded-md bg-emerald-500/12 px-1.5 py-0.5 text-[11px] font-medium text-emerald-700 dark:text-emerald-300"><ShieldCheck className="h-3 w-3" /> 只读·安全</span>
              : <span className="inline-flex items-center gap-1 rounded-md bg-amber-500/12 px-1.5 py-0.5 text-[11px] font-medium text-amber-700 dark:text-amber-300"><AlertTriangle className="h-3 w-3" /> 有副作用</span>}
            {isStream && <span className="inline-flex items-center gap-1 rounded-md bg-primary/12 px-1.5 py-0.5 text-[11px] font-medium text-primary"><Zap className="h-3 w-3" /> 流式</span>}
            <span>{doc.summary}{doc.returns ? <> · 返回 <code className="font-mono text-[11px]">{doc.returns}</code></> : null}</span>
          </div>
        )}

        <div className="flex items-center justify-between">
          <span className="text-xs font-medium text-muted-foreground">参数</span>
          <Segmented value={effectiveMode} onChange={setParamMode}
            options={[{ value: 'form', label: '表单' }, { value: 'json', label: 'JSON' }]} />
        </div>

        {effectiveMode === 'json' ? (
          <Textarea className="min-h-28 rounded-xl font-mono text-xs" value={rawJson}
            onChange={(e) => setRawJson(e.target.value)} placeholder='{ "group_id": 12345, "message": "hi" }' />
        ) : (
          <div className="flex flex-col gap-3.5">
            {doc!.params.length === 0 && <p className="text-[12px] text-muted-foreground">该接口无参数。</p>}
            {doc!.params.map((p) => (
              <Field key={p.name} label={<>{p.name}<span className="ml-1 font-normal text-muted-foreground/70">{p.type}{p.required ? ' · 必填' : ''}</span></>}>
                <ParamField param={p} value={fields[p.name] ?? ''} uin={uin} groupContext={fields['group_id'] ?? ''}
                  onChange={(v) => setFields((f) => {
                    const next = { ...f, [p.name]: v };
                    // Changing the group resets any sibling member picker — its
                    // old uin belongs to the previous group.
                    if (p.role === 'group_id' && doc) for (const mp of doc.params) if (mp.role === 'member_id') next[mp.name] = '';
                    return next;
                  })} />
                {p.desc && <span className="text-[11px] text-muted-foreground/70">{p.desc}</span>}
              </Field>
            ))}
            {doc!.invariants && doc!.invariants.length > 0 && (
              <p className="text-[11px] text-muted-foreground/70">约束:{doc!.invariants.join('；')}</p>
            )}
          </div>
        )}

        <div className="flex gap-2">
          <button type="button" onClick={onExecute} disabled={invoking}
            className="inline-flex h-11 flex-1 items-center justify-center gap-2 rounded-xl bg-primary text-[15px] font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.99] disabled:opacity-50">
            {invoking ? <Loader2 className="h-4 w-4 animate-spin" /> : isStream ? <Zap className="h-4 w-4" /> : <Play className="h-4 w-4" />}
            {invoking ? '执行中…' : isStream ? '流式执行' : '执行'}
          </button>
          {invoking && isStream && streamAbort.current && (
            <button type="button" onClick={() => streamAbort.current?.abort()}
              className="inline-flex h-11 items-center justify-center gap-1.5 rounded-xl border border-border px-4 text-sm font-medium text-muted-foreground hover:bg-muted">
              取消
            </button>
          )}
        </div>
      </motion.section>

      {/* response / frames / history */}
      <motion.section
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.05 }}
        className={cn(cardCls, 'flex min-h-[20rem] flex-col gap-3 p-6 xl:col-span-5')}
      >
        {showHistory ? (
          <>
            <div className="flex items-center justify-between">
              <h3 className="text-[15px] font-semibold tracking-tight">调用历史</h3>
              {history.length > 0 && (
                <button type="button" onClick={() => { clearHistory(); setHistory([]); }}
                  className="inline-flex items-center gap-1 text-xs text-muted-foreground hover:text-destructive"><Trash2 className="h-3.5 w-3.5" /> 清空</button>
              )}
            </div>
            <div className="flex flex-col gap-1 overflow-auto">
              {history.length === 0 ? <p className="py-8 text-center text-sm text-muted-foreground">暂无历史</p> : history.map((rec) => (
                <button key={rec.id} type="button" onClick={() => replay(rec)}
                  className="group flex items-center gap-2 rounded-lg px-2.5 py-2 text-left text-[13px] hover:bg-muted/50">
                  <span className={cn('h-1.5 w-1.5 shrink-0 rounded-full', rec.ok ? 'bg-emerald-500' : 'bg-destructive')} />
                  <span className="min-w-0 flex-1 truncate font-mono">{rec.action}</span>
                  <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{rec.uin}</span>
                  <span className="shrink-0 text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100"><RotateCcw className="h-3.5 w-3.5" /></span>
                </button>
              ))}
            </div>
          </>
        ) : (
          <>
            <div className="flex items-center gap-2">
              <h3 className="text-[15px] font-semibold tracking-tight">{isStream ? '帧流' : '响应'}</h3>
              {result && (
                <span className={cn('text-xs font-medium', resultFailed ? 'text-destructive' : 'text-success')}>
                  {resultFailed ? '失败' : '成功'}
                  {!('error' in result) && resultFailed && (result.message || result.wording) ? ` · ${result.message || result.wording}` : ''}
                </span>
              )}
            </div>
            {frames.length > 0 && (
              <div className="flex flex-col gap-1.5 overflow-auto">
                <span className="text-xs text-muted-foreground tabular-nums">{frames.length} 帧</span>
                {frames.map((f, i) => {
                  // On a failed frame the action's `data` is replaced with an
                  // {type:'error'} marker and the reason moves to message/wording
                  // — render the whole frame so the reason stays visible.
                  const failed = f.status === 'failed' || (f.data as { type?: string } | undefined)?.type === 'error';
                  return (
                    <div key={i} className="rounded-lg border border-border/50 bg-muted/20 p-2">
                      <JsonTree data={failed ? f : (f.data ?? f)} maxHeight="12rem" />
                    </div>
                  );
                })}
              </div>
            )}
            {result && !('error' in result) && frames.length === 0 && (
              <JsonTree data={result} maxHeight="28rem" />
            )}
            {result && 'error' in result && (
              <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{result.error}</div>
            )}
            {!result && frames.length === 0 && (
              <p className="flex flex-1 items-center justify-center py-12 text-center text-sm text-muted-foreground">执行后在此查看结果</p>
            )}
          </>
        )}
      </motion.section>

      {confirmOpen && (
        <ConfirmDestructive
          action={actionName}
          uin={uin}
          onCancel={() => setConfirmOpen(false)}
          onConfirm={() => { setConfirmOpen(false); void runInvoke(); }}
        />
      )}
    </div>
  );
}

function ConfirmDestructive({ action, uin, onCancel, onConfirm }: { action: string; uin: string; onCancel: () => void; onConfirm: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onCancel(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onCancel]);
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 backdrop-blur-sm" onClick={onCancel}>
      <motion.div
        initial={{ opacity: 0, scale: 0.96 }} animate={{ opacity: 1, scale: 1 }}
        onClick={(e) => e.stopPropagation()}
        className="w-full max-w-sm rounded-2xl border border-border/60 bg-card p-5 shadow-xl"
      >
        <div className="flex items-center gap-2.5">
          <div className="flex h-9 w-9 items-center justify-center rounded-xl bg-destructive/12 text-destructive"><AlertTriangle className="h-5 w-5" /></div>
          <h3 className="text-base font-semibold">确认执行破坏性操作</h3>
        </div>
        <p className="mt-3 text-sm text-muted-foreground">
          即将以账号 <code className="font-mono text-foreground">{uin}</code> 执行 <code className="font-mono text-foreground">{action}</code>,该操作会<strong className="text-foreground">真实生效且通常不可撤销</strong>。确认继续?
        </p>
        <div className="mt-5 flex justify-end gap-2">
          <button type="button" onClick={onCancel} className="rounded-lg border border-border px-4 py-2 text-sm font-medium hover:bg-muted">取消</button>
          <button type="button" onClick={onConfirm} className="rounded-lg bg-destructive px-4 py-2 text-sm font-medium text-destructive-foreground hover:bg-destructive/90">确认执行</button>
        </div>
      </motion.div>
    </div>
  );
}
