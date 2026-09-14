import { motion } from 'motion/react';
import { cn } from '@/lib/utils';

interface ToggleSwitchProps {
  value: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
  disabled?: boolean;
}

/** Small animated on/off switch (`role="switch"`). Shared across the config
 *  surfaces — node enable toggle, built-in command toggles, etc. */
export function ToggleSwitch({ value, onChange, ariaLabel, disabled }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value ? 'true' : 'false'}
      aria-label={ariaLabel}
      disabled={disabled}
      onClick={() => onChange(!value)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 items-center rounded-full transition-colors',
        'outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
        disabled ? 'cursor-not-allowed opacity-50' : 'cursor-pointer',
        // Off-track is a neutral foreground tint so it stays visible on any
        // surface — including OLED pure-black (where bg-muted vanished).
        value ? 'bg-primary' : 'bg-foreground/20',
      )}
    >
      <motion.span
        className="inline-block size-4 rounded-full bg-white shadow-sm ring-1 ring-black/10"
        animate={{ x: value ? 22 : 4 }}
        transition={{ type: 'spring', stiffness: 500, damping: 30 }}
      />
    </button>
  );
}
