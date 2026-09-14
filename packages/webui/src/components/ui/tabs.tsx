// Tabs — a horizontal section-navigation bar with a sliding underline and full
// roving-tabindex keyboard support (←/→/Home/End). Generic over a string union
// of tab ids.
import {
  useCallback,
  useEffect,
  useId,
  useRef,
  useState,
  type HTMLAttributes,
  type ReactNode,
} from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

interface ScrollableTabListProps extends Omit<HTMLAttributes<HTMLDivElement>, 'onScroll'> {
  activeValue: string;
}

/**
 * Horizontal tab viewport with discoverable overflow and active-item tracking.
 *
 * Callers keep ownership of the tab visuals; active tabs only need the
 * `data-tab-active` marker so the viewport can reveal them after a change.
 */
export function ScrollableTabList({
  activeValue,
  className,
  children,
  ...props
}: ScrollableTabListProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const didMount = useRef(false);
  const [edges, setEdges] = useState({ start: false, end: false });

  const updateEdges = useCallback(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const maxScroll = Math.max(0, viewport.scrollWidth - viewport.clientWidth);
    const next = {
      start: viewport.scrollLeft > 1,
      end: viewport.scrollLeft < maxScroll - 1,
    };
    setEdges((current) => (
      current.start === next.start && current.end === next.end ? current : next
    ));
  }, []);

  const revealActive = useCallback((behavior: ScrollBehavior) => {
    const viewport = viewportRef.current;
    const active = viewport?.querySelector<HTMLElement>('[data-tab-active="true"]');
    if (!viewport || !active) return;

    const edgePadding = 24;
    const visibleStart = viewport.scrollLeft + edgePadding;
    const visibleEnd = viewport.scrollLeft + viewport.clientWidth - edgePadding;
    const itemStart = active.offsetLeft;
    const itemEnd = itemStart + active.offsetWidth;
    let nextLeft = viewport.scrollLeft;

    if (itemStart < visibleStart) nextLeft = itemStart - edgePadding;
    else if (itemEnd > visibleEnd) nextLeft = itemEnd - viewport.clientWidth + edgePadding;

    viewport.scrollTo({ left: Math.max(0, nextLeft), behavior });
  }, []);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;

    const syncLayout = () => {
      revealActive('auto');
      updateEdges();
    };
    const resizeObserver = new ResizeObserver(syncLayout);
    resizeObserver.observe(viewport);
    Array.from(viewport.children).forEach((child) => resizeObserver.observe(child));

    const mutationObserver = new MutationObserver(() => {
      resizeObserver.disconnect();
      resizeObserver.observe(viewport);
      Array.from(viewport.children).forEach((child) => resizeObserver.observe(child));
      syncLayout();
    });
    mutationObserver.observe(viewport, { childList: true });
    syncLayout();

    return () => {
      mutationObserver.disconnect();
      resizeObserver.disconnect();
    };
  }, [revealActive, updateEdges]);

  useEffect(() => {
    const reduceMotion = document.documentElement.dataset.reduceMotion === '1'
      || window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    revealActive(didMount.current && !reduceMotion ? 'smooth' : 'auto');
    didMount.current = true;

    const frame = requestAnimationFrame(updateEdges);
    return () => cancelAnimationFrame(frame);
  }, [activeValue, revealActive, updateEdges]);

  return (
    <div className="relative w-full min-w-0 max-w-full">
      <div
        ref={viewportRef}
        onScroll={updateEdges}
        data-scroll-start={edges.start ? '' : undefined}
        data-scroll-end={edges.end ? '' : undefined}
        className={cn(
          'flex min-w-0 max-w-full overflow-x-auto overscroll-x-contain scroll-px-6 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden',
          className,
        )}
        {...props}
      >
        {children}
      </div>
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 left-0 z-20 w-6 bg-gradient-to-r from-background via-background/80 to-transparent transition-opacity duration-150',
          edges.start ? 'opacity-100' : 'opacity-0',
        )}
      />
      <span
        aria-hidden="true"
        className={cn(
          'pointer-events-none absolute inset-y-0 right-0 z-20 w-6 bg-gradient-to-l from-background via-background/80 to-transparent transition-opacity duration-150',
          edges.end ? 'opacity-100' : 'opacity-0',
        )}
      />
    </div>
  );
}

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
    <ScrollableTabList
      activeValue={value}
      role="tablist"
      aria-label={rest['aria-label']}
      className={cn('w-full items-stretch gap-1 border-b border-border/70', className)}
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
            data-tab-active={active ? 'true' : undefined}
            tabIndex={active ? 0 : -1}
            onClick={() => onChange(it.value)}
            onKeyDown={(e) => {
              if (e.key === 'ArrowRight') { e.preventDefault(); move(i, 1); }
              else if (e.key === 'ArrowLeft') { e.preventDefault(); move(i, -1); }
              else if (e.key === 'Home') { e.preventDefault(); move(i, 'home'); }
              else if (e.key === 'End') { e.preventDefault(); move(i, 'end'); }
            }}
            className={cn(
              'relative z-10 inline-flex min-h-11 shrink-0 items-center gap-2 whitespace-nowrap rounded-t-lg px-3 py-2 text-sm font-medium outline-none transition-colors',
              'focus-visible:ring-[3px] focus-visible:ring-ring/40',
              active
                ? 'bg-primary/[0.055] text-primary'
                : 'text-muted-foreground hover:bg-muted/55 hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId={`tabs-${layoutId}`}
                transition={{ type: 'spring', stiffness: 500, damping: 40 }}
                className="absolute inset-x-3 bottom-0 h-0.5 rounded-full bg-primary"
              />
            )}
            {it.icon}
            <span>{it.label}</span>
            {it.badge != null && (
              <span className={cn('rounded-full px-1.5 text-meta tabular-nums',
                active ? 'bg-primary/12 text-primary' : 'bg-muted text-muted-foreground')}>
                {it.badge}
              </span>
            )}
          </button>
        );
      })}
    </ScrollableTabList>
  );
}
