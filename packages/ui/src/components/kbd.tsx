import * as React from 'react';
import { cn } from '../lib/cn';

/** Small inline keyboard-key label, e.g. `<Kbd>⌘K</Kbd>`. */
export const Kbd = React.forwardRef<HTMLElement, React.HTMLAttributes<HTMLElement>>(
  ({ className, ...props }, ref) => (
    <kbd
      ref={ref}
      className={cn(
        'inline-flex h-5 min-w-[1.25rem] items-center justify-center rounded border border-border bg-muted px-1 font-mono text-[10px] font-medium text-muted-foreground',
        className,
      )}
      {...props}
    />
  ),
);
Kbd.displayName = 'Kbd';
