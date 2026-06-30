// Tabs — a horizontal tab bar with an Apple-HIG sliding indicator. Shares the
// spring-pill idiom of the debug page's segmented control but scaled up for
// top-level section switching, with full roving-tabindex keyboard support
// (←/→/Home/End). Generic over a string union of tab ids.
import { useId, useRef, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export interface TabItem<T extends string> {
  value: T;
  label: ReactNode;
  /** Optional leading icon (already sized by the caller, ~16px). */
  icon?: ReactNode;
  /** Optional trailing count / badge. */
  badge?: ReactNode;
}

interface TabsProps<T extends string> {
  value: T;
  onChange: (v: T) => void;
  items: ReadonlyArray<TabItem<T>>;
  className?: string;
  'aria-label'?: string;
}

export function Tabs<T extends string>({ value, onChange, items, className, ...rest }: TabsProps<T>) {
  const layoutId = useId();
  const refs = useRef<(HTMLButtonElement | null)[]>([]);

  const move = (from: number, dir: 1 | -1 | 'home' | 'end') => {
    const n = items.length;
    let to: number;
    if (dir === 'home') to = 0;
    else if (dir === 'end') to = n - 1;
    else to = (from + dir + n) % n;
    const next = items[to];
    if (next) { onChange(next.value); refs.current[to]?.focus(); }
  };

  return (
    <div
      role="tablist"
      aria-label={rest['aria-label']}
      className={cn('relative flex items-center gap-1 overflow-x-auto', className)}
    >
      {items.map((it, i) => {
        const active = it.value === value;
        return (
          <button
            key={it.value}
            ref={(el) => { refs.current[i] = el; }}
            role="tab"
            type="button"
            aria-selected={active}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(it.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(i, 1); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i, -1); }
              else if (e.key === 'Home') { e.preventDefault(); move(i, 'home'); }
              else if (e.key === 'End') { e.preventDefault(); move(i, 'end'); }
            }}
            className={cn(
              'relative z-10 inline-flex shrink-0 items-center gap-2 rounded-xl px-3.5 py-2 text-sm font-medium outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/40',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={`tabs-${layoutId}`}
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                className="absolute inset-0 -z-10 rounded-xl bg-card shadow-sm ring-1 ring-border/60"
              />
            )}
            {it.icon}
            <span>{it.label}</span>
            {it.badge != null && (
              <span className={cn('rounded-full px-1.5 text-[11px] tabular-nums',
                active ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>
                {it.badge}
              </span>
            )}
          </button>
        );
      })}
    </div>
  );
}
