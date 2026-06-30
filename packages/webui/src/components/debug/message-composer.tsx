// MessageComposer — the standalone "消息构建" tab: pick a target (group or
// friend), build a message visually, preview it, send it. A message containing
// forward nodes goes through the forward-send action; otherwise the plain
// send_*_msg. The chosen group provides the @-member context to the builder.
import { useEffect, useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { Loader2, MessageSquarePlus, Send } from 'lucide-react';
import { Select } from '@/components/ui/select';
import { Picker } from '@/components/ui/picker';
import { JsonTree } from '@/components/ui/json-tree';
import { Segmented } from '@/components/debug/segmented';
import { MessageBuilder, hasNodes, previewSegments, toOneBot, validateSegs, type Seg } from '@/components/debug/message-builder';
import { useFriends, useGroups } from '@/hooks/use-debug-contacts';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { DebugInvokeResult, QQInfo } from '@/types';

const cardCls = 'rounded-2xl border border-border/60 bg-card/80 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.10)] backdrop-blur-sm';
const looksLikeId = (s: string) => /^\d{3,}$/.test(s.trim());

function TargetPicker({ kind, uin, value, onChange }: { kind: 'group' | 'friend'; uin: string; value: string; onChange: (v: string) => void }) {
  const groups = useGroups(kind === 'group' ? uin : '');
  const friends = useFriends(kind === 'friend' ? uin : '');
  const src = kind === 'group' ? groups : friends;
  return (
    <Picker ariaLabel={kind === 'group' ? '选择群' : '选择好友'} value={value} onChange={onChange}
      options={src.items} loading={src.loading} error={src.error} onRefresh={src.refresh}
      placeholder={kind === 'group' ? '选择群…' : '选择好友…'} validateRaw={looksLikeId} />
  );
}

export function MessageComposer({ accounts }: { accounts: QQInfo[] }) {
  const api = useApi();
  const [uin, setUin] = useState('');
  const [kind, setKind] = useState<'group' | 'friend'>('group');
  const [target, setTarget] = useState('');
  const [segs, setSegs] = useState<Seg[]>([]);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<DebugInvokeResult | { error: string } | null>(null);

  // default to the first account once loaded
  useEffect(() => { if (!uin && accounts[0]) setUin(accounts[0].uin); }, [accounts, uin]);

  const preview = useMemo(() => previewSegments(segs), [segs]);
  const groupId = kind === 'group' ? target : '';

  const send = async () => {
    if (!uin) { setResult({ error: '请选择账号' }); return; }
    if (!target) { setResult({ error: kind === 'group' ? '请选择群' : '请选择好友' }); return; }
    if (segs.length === 0) { setResult({ error: '消息为空' }); return; }
    const forward = hasNodes(segs);
    // Forward messages must be ALL nodes: the backend silently drops top-level
    // non-node segments, so a mixed message would send less than the preview
    // shows. Block it with a clear message instead.
    if (forward && !segs.every((s) => s.k === 'node')) {
      setResult({ error: '合并转发消息只能由转发节点组成 — 请移除非节点段,或把它们放进某个转发节点内' });
      return;
    }
    const incomplete = validateSegs(segs);
    if (incomplete) { setResult({ error: incomplete }); return; }
    const payload = toOneBot(segs);
    const action = forward
      ? (kind === 'group' ? 'send_group_forward_msg' : 'send_private_forward_msg')
      : (kind === 'group' ? 'send_group_msg' : 'send_private_msg');
    const params: Record<string, unknown> = kind === 'group' ? { group_id: target } : { user_id: target };
    params[forward ? 'messages' : 'message'] = payload;

    setSending(true);
    setResult(null);
    try {
      setResult(await api.debug.invoke(uin, action, params));
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : '发送失败' });
    } finally {
      setSending(false);
    }
  };

  const resultFailed = !!result && ('error' in result || result.status === 'failed');

  return (
    <div className="grid grid-cols-1 gap-6 xl:grid-cols-12">
      <motion.section
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
        className={cn(cardCls, 'flex flex-col gap-5 p-6 xl:col-span-7')}
      >
        <div className="flex items-center gap-2.5">
          <MessageSquarePlus className="h-[18px] w-[18px] text-primary" />
          <h2 className="text-[15px] font-semibold tracking-tight">消息构建</h2>
        </div>

        <div className="grid gap-4 sm:grid-cols-[auto_1fr]">
          <div className="flex flex-col gap-1.5">
            {/* Fixed h-8 == the target column's segmented-control height, so both
                label rows are exactly equal and the two selectors below share a
                baseline (min-h-7 wasn't enough — the segmented is ~32px). */}
            <div className="flex h-8 items-center">
              <span className="text-xs font-medium text-muted-foreground">账号</span>
            </div>
            <Select value={uin} onChange={(e) => setUin(e.target.value)} className="w-full sm:w-44">
              {accounts.length === 0 && <option value="">(无在线账号)</option>}
              {accounts.map((a) => <option key={a.uin} value={a.uin}>{a.nickname || a.uin}</option>)}
            </Select>
          </div>
          <div className="flex flex-col gap-1.5">
            <div className="flex h-8 items-center justify-between">
              <span className="text-xs font-medium text-muted-foreground">目标</span>
              <Segmented value={kind} onChange={(k) => { setKind(k); setTarget(''); }}
                options={[{ value: 'group', label: '群聊' }, { value: 'friend', label: '私聊' }]} />
            </div>
            <TargetPicker kind={kind} uin={uin} value={target} onChange={setTarget} />
          </div>
        </div>

        <div className="flex flex-col gap-2">
          <span className="text-xs font-medium text-muted-foreground">消息内容</span>
          <MessageBuilder segments={segs} onChange={setSegs} uin={uin} groupId={groupId} />
        </div>

        <button type="button" onClick={send} disabled={sending}
          className="inline-flex h-11 items-center justify-center gap-2 rounded-xl bg-primary text-[15px] font-medium text-primary-foreground shadow-sm transition-all hover:bg-primary/90 active:scale-[0.99] disabled:opacity-50">
          {sending ? <Loader2 className="h-4 w-4 animate-spin" /> : <Send className="h-4 w-4" />} 发送{hasNodes(segs) ? '(合并转发)' : ''}
        </button>
      </motion.section>

      <motion.section
        initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35, delay: 0.05 }}
        className={cn(cardCls, 'flex min-h-[20rem] flex-col gap-3 p-6 xl:col-span-5')}
      >
        <h3 className="text-[15px] font-semibold tracking-tight">预览</h3>
        <div className="rounded-xl border border-border/60 bg-muted/30 p-3 text-sm">
          {preview ? <span className="whitespace-pre-wrap break-words">{preview}</span> : <span className="text-muted-foreground">消息为空</span>}
        </div>
        <span className="text-xs font-medium text-muted-foreground">OneBot 段</span>
        <JsonTree data={toOneBot(segs)} maxHeight="14rem" />

        {result && (
          <div className="flex flex-col gap-1.5">
            <span className={cn('text-xs font-medium', resultFailed ? 'text-destructive' : 'text-success')}>{resultFailed ? '发送失败' : '已发送'}</span>
            {'error' in result
              ? <div className="rounded-xl bg-destructive/10 p-3 text-sm text-destructive">{result.error}</div>
              : <JsonTree data={result} maxHeight="12rem" />}
          </div>
        )}
      </motion.section>
    </div>
  );
}
