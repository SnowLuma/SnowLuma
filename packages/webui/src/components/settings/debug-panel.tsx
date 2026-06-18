// Settings → 调试 tab (Wave A3). Two tools over /api/debug/*:
//  1) Action 测试台 — pick an account, pick an action (schema-driven form, or a
//     raw-JSON escape hatch for legacy/freeform), invoke, see the response.
//     Invocations are REAL (send messages, kick, etc.) — flagged in red.
//  2) 实时流 — merged live SSE of OneBot events + action calls across accounts,
//     with pause / clear / kind filter.
import { useEffect, useMemo, useRef, useState } from 'react';
import { Bug, ChevronRight, Loader2, Pause, Play, Trash2 } from 'lucide-react';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
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

export function DebugPanel() {
  const api = useApi();

  // ── action tester ──
  const [accounts, setAccounts] = useState<QQInfo[]>([]);
  const [docs, setDocs] = useState<DebugActionDoc[]>([]);
  const [uin, setUin] = useState('');
  const [actionName, setActionName] = useState('');
  const [fields, setFields] = useState<Record<string, string>>({});
  const [rawMode, setRawMode] = useState(false);
  const [rawJson, setRawJson] = useState('{}');
  const [invoking, setInvoking] = useState(false);
  const [result, setResult] = useState<DebugInvokeResult | { error: string } | null>(null);

  const doc = useMemo(() => docs.find((d) => d.name === actionName), [docs, actionName]);

  useEffect(() => {
    void (async () => {
      try {
        const [qq, acts] = await Promise.all([api.qqList(), api.debug.actions()]);
        setAccounts(qq);
        setDocs(acts.actions);
        if (qq[0]) setUin(qq[0].uin);
      } catch { /* surfaced lazily */ }
    })();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const invoke = async () => {
    if (!uin) { setResult({ error: '请选择账号' }); return; }
    if (!actionName.trim()) { setResult({ error: '请填写 action' }); return; }
    let params: Record<string, unknown> = {};
    if (rawMode || !doc) {
      try { params = JSON.parse(rawJson || '{}'); } catch { setResult({ error: 'params JSON 无效' }); return; }
      if (typeof params !== 'object' || params === null || Array.isArray(params)) { setResult({ error: 'params 必须是对象' }); return; }
    } else {
      for (const p of doc.params) {
        const v = coerceParam(p.type, fields[p.name] ?? '');
        if (v !== undefined) params[p.name] = v;
      }
    }
    setInvoking(true);
    setResult(null);
    try {
      setResult(await api.debug.invoke(uin, actionName.trim(), params));
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : '调用失败' });
    } finally {
      setInvoking(false);
    }
  };

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
        if (m.kind === 'ready') return;
        if (pausedRef.current) return;
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
    <div className="flex flex-col gap-5">
      <div className="flex items-start gap-2 rounded-lg border border-amber-500/30 bg-amber-500/10 px-3 py-2 text-xs text-amber-700 dark:text-amber-300">
        <Bug className="mt-0.5 h-3.5 w-3.5 shrink-0" />
        <span>测试台调用会<strong>真实生效</strong>（真发消息 / 真踢人等），请谨慎操作。</span>
      </div>

      {/* Action tester */}
      <Card>
        <CardHeader>
          <CardTitle className="text-sm">Action 测试台</CardTitle>
          <CardDescription>选择账号与接口，填参数后调用并查看响应。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <div className="flex flex-col gap-1.5">
              <Label>账号</Label>
              <Select value={uin} onChange={(e) => setUin(e.target.value)}>
                {accounts.length === 0 && <option value="">（无在线账号）</option>}
                {accounts.map((a) => <option key={a.uin} value={a.uin}>{a.nickname || a.uin}（{a.uin}）</option>)}
              </Select>
            </div>
            <div className="flex flex-col gap-1.5">
              <Label>Action</Label>
              <Input
                list="debug-actions"
                value={actionName}
                onChange={(e) => { setActionName(e.target.value); setResult(null); }}
                placeholder="如 send_group_msg"
              />
              <datalist id="debug-actions">
                {docs.map((d) => <option key={d.name} value={d.name}>{d.summary}</option>)}
              </datalist>
            </div>
          </div>

          {doc && <p className="text-[11px] text-muted-foreground">{doc.summary}{doc.returns ? ` · 返回 ${doc.returns}` : ''}</p>}

          <div className="flex items-center justify-between">
            <Label className="text-xs text-muted-foreground">原始 JSON 参数（覆盖表单；legacy 接口必用）</Label>
            <Button variant="ghost" size="sm" onClick={() => setRawMode((v) => !v)}>{rawMode ? '用表单' : '用 JSON'}</Button>
          </div>

          {rawMode || !doc ? (
            <Textarea className="min-h-24 font-mono text-xs" value={rawJson} onChange={(e) => setRawJson(e.target.value)} placeholder='{"group_id": 12345, "message": "hi"}' />
          ) : (
            <div className="flex flex-col gap-2">
              {doc.params.length === 0 && <p className="text-[11px] text-muted-foreground">无参数。</p>}
              {doc.params.map((p) => (
                <div key={p.name} className="flex flex-col gap-1">
                  <Label className="text-xs">
                    {p.name}<span className="ml-1 text-muted-foreground">({p.type}{p.required ? ' *' : ''})</span>
                  </Label>
                  <Input
                    value={fields[p.name] ?? ''}
                    onChange={(e) => setFields((f) => ({ ...f, [p.name]: e.target.value }))}
                    placeholder={p.desc || (p.default !== undefined ? `默认 ${JSON.stringify(p.default)}` : '')}
                  />
                </div>
              ))}
            </div>
          )}

          <div>
            <Button onClick={invoke} disabled={invoking} className="gap-1.5">
              {invoking ? <Loader2 className="h-4 w-4 animate-spin" /> : <Play className="h-4 w-4" />} 执行
            </Button>
          </div>

          {result && (
            <pre className={cn('max-h-72 overflow-auto rounded-lg border border-border bg-muted/30 p-3 font-mono text-xs',
              'error' in result || result.status === 'failed' ? 'text-red-600 dark:text-red-400' : '')}>
              {JSON.stringify(result, null, 2)}
            </pre>
          )}
        </CardContent>
      </Card>

      {/* Live stream */}
      <Card>
        <CardHeader>
          <CardTitle className="flex items-center gap-2 text-sm">
            实时流
            <span className={cn('inline-block h-2 w-2 rounded-full',
              status === 'open' ? 'bg-emerald-500' : status === 'reconnecting' ? 'bg-amber-500' : 'bg-muted-foreground')} />
          </CardTitle>
          <CardDescription>所有账号的 OneBot 事件与 action 调用（实时）。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <Button variant="outline" size="sm" onClick={() => setPaused((v) => !v)} className="gap-1.5">
              {paused ? <Play className="h-3.5 w-3.5" /> : <Pause className="h-3.5 w-3.5" />} {paused ? '继续' : '暂停'}
            </Button>
            <Button variant="outline" size="sm" onClick={() => setRows([])} className="gap-1.5"><Trash2 className="h-3.5 w-3.5" /> 清空</Button>
            <div className="w-32">
              <Select value={kindFilter} onChange={(e) => setKindFilter(e.target.value as 'all' | 'event' | 'action')}>
                <option value="all">全部</option>
                <option value="event">事件</option>
                <option value="action">调用</option>
              </Select>
            </div>
            <span className="text-[11px] text-muted-foreground">{visible.length} 条{paused ? ' · 已暂停' : ''}</span>
          </div>

          <div className="flex max-h-96 flex-col gap-1 overflow-auto">
            {visible.length === 0 && <p className="px-1 py-6 text-center text-xs text-muted-foreground">暂无数据…</p>}
            {visible.map((r) => <StreamRowItem key={r.id} row={r} />)}
          </div>
        </CardContent>
      </Card>
    </div>
  );
}

function StreamRowItem({ row }: { row: StreamRow }) {
  const [open, setOpen] = useState(false);
  const { msg } = row;
  const time = new Date(row.at).toLocaleTimeString();
  let label: string;
  let detail: unknown;
  if (msg.kind === 'dropped') {
    return <div className="px-2 py-1 text-[11px] text-amber-600 dark:text-amber-400">⚠ 因客户端过慢丢弃了 {msg.count} 条</div>;
  } else if (msg.kind === 'event') {
    const e = msg.event;
    label = `${e.post_type ?? 'event'}${e.message_type ? `.${e.message_type}` : e.notice_type ? `.${e.notice_type}` : ''}`;
    detail = e;
  } else {
    const ok = (msg.response as { status?: string }).status === 'ok';
    label = `${msg.action} → ${ok ? 'ok' : 'failed'} (${msg.ms}ms)`;
    detail = { params: msg.params, response: msg.response };
  }
  return (
    <div className="rounded border border-border/60 bg-card/40 text-xs">
      <button className="flex w-full items-center gap-2 px-2 py-1 text-left" onClick={() => setOpen((v) => !v)}>
        <ChevronRight className={cn('h-3 w-3 shrink-0 transition-transform', open && 'rotate-90')} />
        <span className="text-muted-foreground tabular-nums">{time}</span>
        <Badge variant={msg.kind === 'action' ? 'default' : 'secondary'} className="text-[10px]">{msg.kind === 'action' ? '调用' : '事件'}</Badge>
        <span className="text-muted-foreground">{msg.uin}</span>
        <span className="truncate font-mono">{label}</span>
      </button>
      {open && <pre className="max-h-64 overflow-auto border-t border-border/60 p-2 font-mono text-[11px]">{JSON.stringify(detail, null, 2)}</pre>}
    </div>
  );
}
