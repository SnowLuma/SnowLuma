// Segmented — an iOS-style segmented control with a sliding active pill. Shared
// by the debug console's tester / stream panels. Extracted from the original
// debug page so multiple panels reuse one implementation.
import { useId, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

export function Segmented<T extends string>({ value, onChange, options }: {
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
