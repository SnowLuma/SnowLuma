import * as React from 'react';
import { cn } from '../lib/cn';

interface ProgressProps extends React.HTMLAttributes<HTMLDivElement> {
  value?: number;
  indicatorClassName?: string;
  /**
   * When true, the bar shows an animated marquee instead of a fixed
   * width — useful when we know a job is running but don't yet know
   * the total size (e.g. a download whose Content-Length is unknown).
   */
  indeterminate?: boolean;
}

const Progress = React.forwardRef<HTMLDivElement, ProgressProps>(
  ({ className, value = 0, indicatorClassName, indeterminate = false, ...props }, ref) => {
    const clamped = Math.max(0, Math.min(100, value));
    return (
      <div
        ref={ref}
        role="progressbar"
        aria-valuenow={indeterminate ? undefined : clamped}
        aria-valuemin={0}
        aria-valuemax={100}
        className={cn(
          'relative h-2 w-full overflow-hidden rounded-full bg-muted',
          className,
        )}
        {...props}
      >
        {indeterminate ? (
          <div
            className={cn(
              'absolute inset-y-0 left-0 w-1/3 rounded-full bg-primary',
              'animate-[progress-marquee_1.4s_ease-in-out_infinite]',
              indicatorClassName,
            )}
          />
        ) : (
          <div
            className={cn(
              'h-full rounded-full bg-primary transition-[width] duration-200 ease-out',
              indicatorClassName,
            )}
            style={{ width: `${clamped}%` }}
          />
        )}
      </div>
    );
  },
);
Progress.displayName = 'Progress';

export { Progress };
