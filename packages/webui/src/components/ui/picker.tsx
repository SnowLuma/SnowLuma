// Picker — a searchable, windowed combobox for choosing from large lists
// (group members can be thousands). Apple-HIG flavour built on the same idiom
// as DropdownSelect: calm trigger matching Input height, a soft floating panel
// with a search field, virtualised rows (avatar + name + sub), keyboard nav,
// and an always-present escape hatch — if what you typed isn't in the list you
// can still commit it as a raw value. Loading / error / empty states degrade to
// the raw-value input so the picker never traps you.
import { useEffect, useMemo, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Loader2, RefreshCw, Search } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface PickerOption {
  value: string;
  label: string;
  /** Secondary line (e.g. the uin under a nickname). */
  sub?: string;
  /** Avatar URL. */
  avatar?: string;
}

interface PickerProps {
  value: string;
  onChange: (v: string) => void;
  options: ReadonlyArray<PickerOption>;
  loading?: boolean;
  error?: string | null;
  onRefresh?: () => void;
  placeholder?: string;
  /** Validates a typed raw value before it can be committed via the escape
   *  hatch. Defaults to "non-empty". */
  validateRaw?: (raw: string) => boolean;
  ariaLabel: string;
  className?: string;
  disabled?: boolean;
}

const ROW_H = 44; // px — fixed row height drives the windowing math
const OVERSCAN = 6;
const PANEL_MAX = 264; // px of scroll viewport

export function Picker({
  value, onChange, options, loading, error, onRefresh,
  placeholder = '选择…', validateRaw, ariaLabel, className, disabled,
}: PickerProps) {
  const [open, setOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [scrollTop, setScrollTop] = useState(0);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);

  const selected = options.find((o) => o.value === value);

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return options;
    return options.filter((o) => o.label.toLowerCase().includes(q) || o.value.includes(q) || (o.sub?.toLowerCase().includes(q) ?? false));
  }, [options, query]);

  // The escape-hatch row: show when the query is a committable raw value that
  // isn't already an exact option.
  const canRaw = query.trim() !== '' && (validateRaw ? validateRaw(query.trim()) : true)
    && !options.some((o) => o.value === query.trim());
  const rawRow = canRaw ? query.trim() : null;

  useEffect(() => {
    if (!open) return;
    setScrollTop(0);
    setActive(0);
    const t = setTimeout(() => searchRef.current?.focus(), 10);
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => { clearTimeout(t); document.removeEventListener('pointerdown', onPointer); };
  }, [open]);

  const totalRows = filtered.length + (rawRow ? 1 : 0);
  // Keep the keyboard cursor in range when the list shrinks (refresh / typing)
  // without a keystroke that would have reset it.
  useEffect(() => {
    setActive((a) => Math.min(a, Math.max(0, totalRows - 1)));
  }, [totalRows]);
  const viewH = Math.min(PANEL_MAX, totalRows * ROW_H);
  const start = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
  const end = Math.min(totalRows, Math.ceil((scrollTop + viewH) / ROW_H) + OVERSCAN);

  const commit = (v: string) => { onChange(v); setOpen(false); setQuery(''); };

  const choose = (idx: number) => {
    if (rawRow && idx === filtered.length) commit(rawRow);
    else { const o = filtered[idx]; if (o) commit(o.value); }
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); setOpen(false); return; }
    if (e.key === 'ArrowDown') { e.preventDefault(); setActive((a) => Math.min(totalRows - 1, a + 1)); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); setActive((a) => Math.max(0, a - 1)); }
    else if (e.key === 'Enter') { e.preventDefault(); choose(active); }
  };

  // Keep the active row scrolled into view.
  useEffect(() => {
    if (!open || !listRef.current) return;
    const top = active * ROW_H;
    const el = listRef.current;
    if (top < el.scrollTop) el.scrollTop = top;
    else if (top + ROW_H > el.scrollTop + el.clientHeight) el.scrollTop = top + ROW_H - el.clientHeight;
  }, [active, open]);

  const rows: { idx: number; opt: PickerOption | null }[] = [];
  for (let i = start; i < end; i++) {
    if (rawRow && i === filtered.length) rows.push({ idx: i, opt: null });
    else rows.push({ idx: i, opt: filtered[i] ?? null });
  }

  return (
    <div ref={rootRef} className={cn('relative', className)} onKeyDown={onKeyDown}>
      <button
        type="button"
        disabled={disabled}
        aria-label={ariaLabel}
        aria-haspopup="listbox"
        aria-expanded={open}
        onClick={() => !disabled && setOpen((v) => !v)}
        className={cn(
          'flex h-9 w-full items-center gap-2 rounded-md border border-border bg-transparent px-3 text-sm outline-none transition-colors',
          'focus-visible:ring-[3px] focus-visible:ring-ring/40 focus-visible:border-ring disabled:opacity-50',
          !selected && !value && 'text-muted-foreground',
        )}
      >
        {selected?.avatar && <img src={selected.avatar} alt="" className="h-5 w-5 shrink-0 rounded-full" />}
        <span className="min-w-0 flex-1 truncate text-left">
          {selected ? selected.label : value || placeholder}
          {selected?.sub && <span className="ml-1.5 text-xs text-muted-foreground tabular-nums">{selected.sub}</span>}
        </span>
        <ChevronDown className={cn('h-4 w-4 shrink-0 text-muted-foreground transition-transform', open && 'rotate-180')} />
      </button>

      <AnimatePresence>
        {open && (
          <motion.div
            initial={{ opacity: 0, y: -4, scale: 0.98 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.98 }}
            transition={{ type: 'spring', stiffness: 500, damping: 38 }}
            className="absolute z-50 mt-1.5 w-full overflow-hidden rounded-xl border border-border/60 bg-popover shadow-lg ring-1 ring-black/5"
          >
            <div className="flex items-center gap-2 border-b border-border/60 px-2.5 py-2">
              <Search className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
              <input
                ref={searchRef}
                value={query}
                onChange={(e) => {
                  setQuery(e.target.value);
                  setActive(0);
                  setScrollTop(0);
                  if (listRef.current) listRef.current.scrollTop = 0;
                }}
                placeholder="搜索名称 / 号码…"
                className="min-w-0 flex-1 bg-transparent text-sm outline-none placeholder:text-muted-foreground"
              />
              {onRefresh && (
                <button type="button" title="刷新" onClick={onRefresh}
                  className="shrink-0 text-muted-foreground hover:text-foreground">
                  <RefreshCw className={cn('h-3.5 w-3.5', loading && 'animate-spin')} />
                </button>
              )}
            </div>

            {loading && options.length === 0 ? (
              <div className="flex items-center justify-center gap-2 py-8 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> 加载中…
              </div>
            ) : error ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">
                <p className="text-destructive">{error}</p>
                <p className="mt-1">可直接在上方输入号码后回车使用</p>
              </div>
            ) : totalRows === 0 ? (
              <div className="px-3 py-6 text-center text-xs text-muted-foreground">无匹配项{query && '；输入完整号码可直接使用'}</div>
            ) : (
              <div
                ref={listRef}
                role="listbox"
                onScroll={(e) => setScrollTop((e.target as HTMLDivElement).scrollTop)}
                className="overflow-auto"
                style={{ height: viewH }}
              >
                <div style={{ height: totalRows * ROW_H, position: 'relative' }}>
                  {rows.map(({ idx, opt }) => (
                    <div
                      key={opt ? opt.value : `__raw-${idx}`}
                      role="option"
                      aria-selected={idx === active}
                      onMouseEnter={() => setActive(idx)}
                      onClick={() => choose(idx)}
                      className={cn(
                        'absolute left-0 right-0 flex cursor-pointer items-center gap-2.5 px-3',
                        idx === active ? 'bg-accent text-accent-foreground' : 'hover:bg-accent/50',
                      )}
                      style={{ top: idx * ROW_H, height: ROW_H }}
                    >
                      {opt ? (
                        <>
                          {opt.avatar
                            ? <img src={opt.avatar} alt="" className="h-7 w-7 shrink-0 rounded-full" />
                            : <span className="h-7 w-7 shrink-0 rounded-full bg-muted" />}
                          <span className="min-w-0 flex-1 truncate text-sm">{opt.label}</span>
                          {opt.sub && <span className="shrink-0 font-mono text-[11px] text-muted-foreground tabular-nums">{opt.sub}</span>}
                        </>
                      ) : (
                        <span className="text-sm">使用 <span className="font-mono text-primary">{rawRow}</span></span>
                      )}
                    </div>
                  ))}
                </div>
              </div>
            )}
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
