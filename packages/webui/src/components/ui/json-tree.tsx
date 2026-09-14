// JsonTree — a calm, collapsible JSON viewer for action responses / event
// payloads. Replaces a raw <pre> dump: nodes fold, values are colour-typed, the
// root offers copy, and a string that looks like an image URL gets an inline
// preview toggle. Read-only; no external deps.
import { useState, type ReactNode } from 'react';
import { Check, ChevronRight, Copy, Image as ImageIcon } from 'lucide-react';
import { cn } from '@/lib/utils';

const IMAGE_URL_RE = /^https?:\/\/[^\s]+?\.(?:png|jpe?g|gif|webp|bmp)(?:[?#][^\s]*)?$/i;
// QQ multimedia rkey image URLs don't end in an extension but carry these hints.
const IMAGE_HINT_RE = /^https?:\/\/[^\s]*(?:rkey=|gchatpic|multimedia|c2cpicdw|offpic|gchat\.qpic)/i;

function isImageUrl(s: string): boolean {
  return IMAGE_URL_RE.test(s) || IMAGE_HINT_RE.test(s);
}

function Punct({ children }: { children: ReactNode }) {
  return <span className="text-muted-foreground/60">{children}</span>;
}

function Leaf({ value }: { value: string | number | boolean | null }) {
  const [showImg, setShowImg] = useState(false);
  if (value === null) return <span className="text-muted-foreground/70">null</span>;
  if (typeof value === 'number') return <span className="text-sky-600 dark:text-sky-400 tabular-nums">{value}</span>;
  if (typeof value === 'boolean') return <span className="text-violet-600 dark:text-violet-400">{String(value)}</span>;
  // string
  const img = isImageUrl(value);
  return (
    <span className="break-all">
      <span className="text-emerald-700 dark:text-emerald-400">&quot;{value}&quot;</span>
      {img && (
        <>
          <button
            type="button"
            onClick={() => setShowImg((v) => !v)}
            className="ml-1.5 inline-flex items-center gap-0.5 rounded-md bg-muted/70 px-1 py-0.5 align-middle text-xs text-muted-foreground hover:text-foreground"
          >
            <ImageIcon className="h-3 w-3" /> {showImg ? '隐藏' : '预览'}
          </button>
          {showImg && (
            <span className="mt-1.5 block">
              <img src={value} alt="预览" className="media-outline max-h-48 rounded-lg" loading="lazy" />
            </span>
          )}
        </>
      )}
    </span>
  );
}

const NODE_CAP = 100; // render at most this many children before "show more"

function Node({ k, value, depth, defaultOpen }: { k?: string; value: unknown; depth: number; defaultOpen: boolean }) {
  const isObj = typeof value === 'object' && value !== null;
  const [open, setOpen] = useState(defaultOpen);
  const [limit, setLimit] = useState(NODE_CAP);

  const keyLabel = k != null ? <><span className="text-foreground/80">{k}</span><Punct>: </Punct></> : null;

  if (!isObj) {
    return (
      <div className="flex gap-1 py-px pl-[1.1rem]" style={{ paddingLeft: `${depth * 0.9 + 1.1}rem` }}>
        {keyLabel}
        <Leaf value={value as string | number | boolean | null} />
      </div>
    );
  }

  const isArr = Array.isArray(value);
  const count = isArr ? (value as unknown[]).length : Object.keys(value as object).length;
  const openB = isArr ? '[' : '{';
  const closeB = isArr ? ']' : '}';
  const shown = open ? Math.min(count, limit) : 0;
  // Only materialise child entries when expanded — a deep tree has many
  // collapsed nodes, and enumerating each on every render is wasted work.
  const entries: ReadonlyArray<readonly [string, unknown]> = open
    ? (isArr
      ? (value as unknown[]).map((v, i) => [String(i), v] as const)
      : Object.entries(value as Record<string, unknown>))
    : [];

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-center gap-1 py-px text-left hover:bg-muted/40"
        style={{ paddingLeft: `${depth * 0.9}rem` }}
      >
        <ChevronRight className={cn('h-3 w-3 shrink-0 text-muted-foreground/60 transition-transform', open && 'rotate-90')} />
        {keyLabel}
        <Punct>{openB}</Punct>
        {!open && <span className="text-muted-foreground/50">{count}{isArr ? '' : ' keys'}<Punct>{closeB}</Punct></span>}
      </button>
      {open && (
        <>
          {entries.slice(0, shown).map(([ck, cv]) => (
            <Node key={ck} k={Array.isArray(value) ? undefined : ck} value={cv} depth={depth + 1} defaultOpen={depth < 1} />
          ))}
          {count > shown && (
            <button
              type="button"
              onClick={() => setLimit((l) => l + 500)}
              className="py-0.5 text-xs text-primary hover:underline"
              style={{ paddingLeft: `${depth * 0.9 + 1.1}rem` }}
            >
              还有 {count - shown} 项,点击展开…
            </button>
          )}
          <div style={{ paddingLeft: `${depth * 0.9 + 0.9}rem` }}><Punct>{closeB}</Punct></div>
        </>
      )}
    </div>
  );
}

export function JsonTree({ data, className, maxHeight = '20rem' }: { data: unknown; className?: string; maxHeight?: string }) {
  const [copied, setCopied] = useState(false);

  const copy = async () => {
    // Stringify lazily, only on an actual copy — not on every render (a large
    // payload would otherwise re-serialise the whole tree each commit).
    const text = (() => { try { return JSON.stringify(data, null, 2); } catch { return String(data); } })();
    try {
      if (navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(text);
      } else {
        // navigator.clipboard is undefined on http LAN deployments — fall back
        // to the legacy execCommand path so copy still works (and shows feedback).
        const ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        document.execCommand('copy');
        document.body.removeChild(ta);
      }
      setCopied(true);
      setTimeout(() => setCopied(false), 1200);
    } catch { /* clipboard blocked */ }
  };

  return (
    <div className={cn('relative rounded-xl border border-border/60 bg-muted/30', className)}>
      <button
        type="button"
        onClick={copy}
        title="复制 JSON"
        className="absolute right-2 top-2 z-10 inline-flex items-center gap-1 rounded-md bg-card/80 px-1.5 py-1 text-xs text-muted-foreground shadow-sm ring-1 ring-border/50 backdrop-blur hover:text-foreground"
      >
        {copied ? <Check className="h-3 w-3 text-success" /> : <Copy className="h-3 w-3" />}
        {copied ? '已复制' : '复制'}
      </button>
      <div className="overflow-auto p-3 font-mono text-[11.5px] leading-relaxed" style={{ maxHeight }}>
        <Node value={data} depth={0} defaultOpen />
      </div>
    </div>
  );
}
