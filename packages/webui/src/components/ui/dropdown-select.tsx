import { useEffect, useRef, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Check, ChevronDown } from 'lucide-react';
import { cn } from '@/lib/utils';

export interface DropdownOption<T extends string> {
  value: T;
  label: string;
}

interface DropdownSelectProps<T extends string> {
  value: T;
  options: ReadonlyArray<DropdownOption<T>>;
  onChange: (v: T) => void;
  ariaLabel: string;
  className?: string;
}

/**
 * Custom (non-native) dropdown with an Apple-HIG flavour: a calm trigger that
 * mirrors {@link Input}'s height/border, a soft floating menu that springs in,
 * and a trailing check on the selected row. Keyboard-driven (arrows / enter /
 * escape) and closes on outside pointer-down. Use when the design wants a menu
 * that matches the surrounding chrome — the plain `Select` stays the zero-dep
 * native fallback for dense forms.
 */
export function DropdownSelect<T extends string>({
  value,
  options,
  onChange,
  ariaLabel,
  className,
}: DropdownSelectProps<T>) {
  const [open, setOpen] = useState(false);
  const [active, setActive] = useState(0);
  const rootRef = useRef<HTMLDivElement>(null);

  const selected = options.find((o) => o.value === value);

  useEffect(() => {
    if (!open) return;
    // Seed the keyboard highlight on the current selection each time we open.
    setActive(Math.max(0, options.findIndex((o) => o.value === value)));
    const onPointer = (e: PointerEvent) => {
      if (rootRef.current && !rootRef.current.contains(e.target as Node)) setOpen(false);
    };
    document.addEventListener('pointerdown', onPointer);
    return () => document.removeEventListener('pointerdown', onPointer);
  }, [open]); // eslint-disable-line react-hooks/exhaustive-deps

  const choose = (v: T) => {
    onChange(v);
    setOpen(false);
  };

  const onKeyDown = (e: React.KeyboardEvent) => {
    if (e.key === 'Escape' && open) {
      // Swallow so the surrounding Dialog doesn't also close on the same key.
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
      return;
    }
    if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
      e.preventDefault();
      if (!open) {
        setOpen(true);
        return;
      }
      setActive((i) => {
        const n = options.length;
        return e.key === 'ArrowDown' ? (i + 1) % n : (i - 1 + n) % n;
      });
      return;
    }
    if (e.key === 'Enter' || e.key === ' ') {
      e.preventDefault();
      if (!open) setOpen(true);
      else if (options[active]) choose(options[active].value);
    }
  };

  return (
    <div ref={rootRef} className={cn('relative', className)}>
      <button
        type="button"
        aria-haspopup="listbox"
        aria-expanded={open}
        aria-label={ariaLabel}
        onClick={() => setOpen((o) => !o)}
        onKeyDown={onKeyDown}
        className={cn(
          'flex h-9 w-full items-center justify-between gap-2 rounded-lg border border-border bg-transparent px-3 text-sm shadow-xs outline-none transition-[color,box-shadow]',
          'hover:bg-accent/40 focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
        )}
      >
        <span className="truncate">{selected?.label ?? ''}</span>
        <ChevronDown
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200',
            open && 'rotate-180',
          )}
        />
      </button>

      <AnimatePresence>
        {open && (
          <motion.ul
            role="listbox"
            aria-label={ariaLabel}
            initial={{ opacity: 0, y: -4, scale: 0.97 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: -4, scale: 0.97 }}
            transition={{ type: 'spring', stiffness: 600, damping: 38 }}
            className="absolute inset-x-0 top-[calc(100%+4px)] z-50 origin-top overflow-hidden rounded-xl border border-border/60 bg-card p-1 shadow-lg backdrop-blur-sm"
          >
            {options.map((o, i) => {
              const isSel = o.value === value;
              const isActive = i === active;
              return (
                <li key={o.value} role="option" aria-selected={isSel}>
                  <button
                    type="button"
                    tabIndex={-1}
                    onMouseEnter={() => setActive(i)}
                    onClick={() => choose(o.value)}
                    className={cn(
                      'flex w-full items-center justify-between gap-2 rounded-lg px-2.5 py-1.5 text-left text-sm transition-colors',
                      isActive ? 'bg-accent text-accent-foreground' : 'text-foreground',
                    )}
                  >
                    <span className="truncate">{o.label}</span>
                    {isSel && <Check className="size-4 shrink-0 text-primary" />}
                  </button>
                </li>
              );
            })}
          </motion.ul>
        )}
      </AnimatePresence>
    </div>
  );
}
