// ApiBrowser — an embedded, searchable reference for every declarative action
// (~520), grouped by category, surfaced straight from /api/debug/actions (the
// same docs the tester uses). Each row expands to params / returns / invariants
// and a 试一下 button that prefills the tester. No hand-maintained docs — this
// is the live catalog.
import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { BookOpen, ChevronRight, PlayCircle, Search, ShieldCheck, Zap } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { DebugActionDoc } from '@/types';

const cardCls = 'rounded-2xl border border-border/60 bg-card/80 shadow-[0_1px_2px_rgb(0_0_0/0.04),0_8px_24px_-12px_rgb(0_0_0/0.10)] backdrop-blur-sm';

function ActionRow({ doc, onTry }: { doc: DebugActionDoc; onTry: (name: string) => void }) {
  const [open, setOpen] = useState(false);
  return (
    <div className="rounded-xl border border-border/50 bg-card/40">
      <button type="button" onClick={() => setOpen((v) => !v)} className="flex w-full items-center gap-2 px-3 py-2 text-left">
        <ChevronRight className={cn('h-3.5 w-3.5 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        <code className="shrink-0 font-mono text-[13px] font-medium">{doc.name}</code>
        {doc.readOnly
          ? <ShieldCheck className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
          : <span className="h-1.5 w-1.5 shrink-0 rounded-full bg-amber-500" title="有副作用" />}
        {doc.stream && <Zap className="h-3.5 w-3.5 shrink-0 text-primary" />}
        <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{doc.summary}</span>
      </button>
      {open && (
        <div className="flex flex-col gap-3 border-t border-border/50 px-3 py-3 text-[13px]">
          {doc.aliases.length > 0 && (
            <p className="text-xs text-muted-foreground">别名:{doc.aliases.map((a) => <code key={a} className="ml-1 font-mono">{a}</code>)}</p>
          )}
          {doc.params.length > 0 ? (
            <div className="overflow-hidden rounded-lg border border-border/50">
              <table className="w-full text-left text-xs">
                <thead className="bg-muted/40 text-muted-foreground">
                  <tr><th className="px-2 py-1 font-medium">参数</th><th className="px-2 py-1 font-medium">类型</th><th className="px-2 py-1 font-medium">必填</th><th className="px-2 py-1 font-medium">说明</th></tr>
                </thead>
                <tbody>
                  {doc.params.map((p) => (
                    <tr key={p.name} className="border-t border-border/40">
                      <td className="px-2 py-1 font-mono">{p.name}</td>
                      <td className="px-2 py-1 font-mono text-muted-foreground">{p.values ? p.values.map(String).join(' | ') : p.type}{p.role ? <span className="ml-1 text-primary/70">·{p.role}</span> : null}</td>
                      <td className="px-2 py-1">{p.required ? '✓' : '–'}</td>
                      <td className="px-2 py-1 text-muted-foreground">{p.desc ?? ''}{p.default !== undefined ? ` (默认 ${JSON.stringify(p.default)})` : ''}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          ) : <p className="text-xs text-muted-foreground">无参数</p>}
          {doc.invariants && doc.invariants.length > 0 && (
            <p className="text-xs text-muted-foreground">约束:{doc.invariants.join('；')}</p>
          )}
          {doc.returns && <p className="text-xs text-muted-foreground">返回:<code className="font-mono">{doc.returns}</code></p>}
          <div>
            <button type="button" onClick={() => onTry(doc.name)}
              className="inline-flex items-center gap-1.5 rounded-lg bg-primary/10 px-2.5 py-1.5 text-xs font-medium text-primary hover:bg-primary/15">
              <PlayCircle className="h-3.5 w-3.5" /> 试一下
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

export function ApiBrowser({ docs, onTry }: { docs: DebugActionDoc[]; onTry: (name: string) => void }) {
  const [query, setQuery] = useState('');
  const [cat, setCat] = useState<string>('');

  const categories = useMemo(() => {
    const set = new Set<string>();
    for (const d of docs) if (d.category) set.add(d.category);
    return Array.from(set).sort();
  }, [docs]);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    return docs.filter((d) => {
      if (cat && d.category !== cat) return false;
      if (!q) return true;
      return d.name.toLowerCase().includes(q)
        || (d.summary?.toLowerCase().includes(q) ?? false)
        || d.aliases.some((a) => a.toLowerCase().includes(q));
    });
  }, [docs, query, cat]);

  const grouped = useMemo(() => {
    const m = new Map<string, DebugActionDoc[]>();
    for (const d of filtered) {
      const k = d.category ?? '其他';
      const arr = m.get(k) ?? [];
      arr.push(d);
      m.set(k, arr);
    }
    return Array.from(m.entries()).sort((a, b) => a[0].localeCompare(b[0]));
  }, [filtered]);

  return (
    <motion.section
      initial={{ opacity: 0, y: 10 }} animate={{ opacity: 1, y: 0 }} transition={{ duration: 0.35 }}
      className={cn(cardCls, 'flex min-h-[28rem] flex-col gap-4 p-6')}
    >
      <div className="flex items-center gap-2.5">
        <BookOpen className="h-[18px] w-[18px] text-primary" />
        <h2 className="text-[15px] font-semibold tracking-tight">API 浏览器</h2>
        <span className="text-xs text-muted-foreground tabular-nums">{filtered.length}/{docs.length}</span>
      </div>

      <div className="flex items-center gap-2 rounded-lg border border-border/60 px-2.5 py-1.5">
        <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
        <input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="搜索 action 名 / 摘要 / 别名…"
          className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground" />
      </div>

      <div className="flex flex-wrap gap-1.5">
        <button type="button" onClick={() => setCat('')}
          className={cn('rounded-full px-2.5 py-1 text-xs font-medium transition-colors', cat === '' ? 'bg-primary text-primary-foreground' : 'bg-muted/70 text-muted-foreground hover:text-foreground')}>全部</button>
        {categories.map((c) => (
          <button key={c} type="button" onClick={() => setCat(c)}
            className={cn('rounded-full px-2.5 py-1 text-xs font-medium transition-colors', cat === c ? 'bg-primary text-primary-foreground' : 'bg-muted/70 text-muted-foreground hover:text-foreground')}>{c}</button>
        ))}
      </div>

      <div className="flex flex-1 flex-col gap-4 overflow-auto">
        {grouped.length === 0 ? (
          <p className="py-12 text-center text-sm text-muted-foreground">无匹配 action</p>
        ) : grouped.map(([category, items]) => (
          <div key={category} className="flex flex-col gap-1.5">
            <h3 className="px-1 text-xs font-semibold text-muted-foreground">{category} <span className="font-normal tabular-nums">{items.length}</span></h3>
            {items.map((d) => <ActionRow key={d.name} doc={d} onTry={onTry} />)}
          </div>
        ))}
      </div>
    </motion.section>
  );
}
