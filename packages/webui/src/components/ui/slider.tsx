import * as React from 'react';
import { cn } from '@/lib/utils';

interface SliderProps extends Omit<React.InputHTMLAttributes<HTMLInputElement>, 'type' | 'value'> {
  value: number;
  min: number;
  max: number;
}

/**
 * Themed range input. Styling lives in index.css (`.slider`); here we just
 * compute the filled-track percentage and expose it as `--slider-pct` for the
 * WebKit track gradient (Firefox fills natively via ::-moz-range-progress).
 */
export function Slider({ value, min, max, className, style, ...props }: SliderProps) {
  const pct = max > min ? Math.min(100, Math.max(0, ((value - min) / (max - min)) * 100)) : 0;
  return (
    <input
      type="range"
      value={value}
      min={min}
      max={max}
      className={cn('slider', className)}
      style={{ '--slider-pct': `${pct}%`, ...style } as React.CSSProperties}
      {...props}
    />
  );
}
