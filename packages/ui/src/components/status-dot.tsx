import * as React from 'react';
import { cva, type VariantProps } from 'class-variance-authority';
import { cn } from '../lib/cn';

/**
 * A semantic colored status dot — drop-in replacement for ad-hoc emoji
 * (🟢 / 🟡 / 🔴) so we keep visual rhythm with the rest of the Lucide
 * iconography. `pulse` adds a soft halo for the "active" state.
 */
const dotVariants = cva('inline-block shrink-0 rounded-full', {
  variants: {
    tone: {
      success: 'bg-success',
      warning: 'bg-warning',
      destructive: 'bg-destructive',
      info: 'bg-info',
      muted: 'bg-muted-foreground/50',
      primary: 'bg-primary',
    },
    size: {
      xs: 'size-1.5',
      sm: 'size-2',
      md: 'size-2.5',
      lg: 'size-3',
    },
  },
  defaultVariants: { tone: 'muted', size: 'sm' },
});

export interface StatusDotProps
  extends React.HTMLAttributes<HTMLSpanElement>,
    VariantProps<typeof dotVariants> {
  pulse?: boolean;
}

export function StatusDot({ className, tone, size, pulse, ...props }: StatusDotProps) {
  return (
    <span
      className={cn(
        'relative inline-flex items-center justify-center',
        pulse && 'before:absolute before:inset-0 before:rounded-full before:bg-current before:opacity-30 before:animate-ping',
        className,
      )}
      {...props}
    >
      <span className={cn(dotVariants({ tone, size }), 'relative')} aria-hidden />
    </span>
  );
}
