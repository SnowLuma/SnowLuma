import { Monitor, Moon, Sun } from 'lucide-react';
import { motion } from 'motion/react';
import { paletteResolved, useTheme, type ThemeMode } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

const OPTIONS: { mode: ThemeMode; icon: typeof Sun; label: string }[] = [
  { mode: 'system', icon: Monitor, label: '跟随系统' },
  { mode: 'light', icon: Sun, label: '浅色' },
  { mode: 'dark', icon: Moon, label: '深色' },
];

export function ThemeToggle({ className }: { className?: string }) {
  const { appearance, mode, setMode } = useTheme();
  // A Catppuccin flavor fixes light/dark, so this quick toggle would be inert
  // (and its pill would desync from the forced scheme) — hide it. Light/dark is
  // then changed by switching the palette back to “默认” in settings.
  if (paletteResolved(appearance.palette)) return null;
  return (
    <div
      className={cn(
        'relative inline-flex shrink-0 items-center rounded-full border bg-card/60 p-0 shadow-xs md:p-0.5',
        className
      )}
    >
      {OPTIONS.map(({ mode: m, icon: Icon, label }) => {
        const active = mode === m;
        return (
          <button
            key={m}
            type="button"
            title={label}
            aria-label={label}
            onClick={() => setMode(m)}
            data-press-scale=""
            className={cn(
              'relative flex size-[44px] items-center justify-center rounded-full transition-[color,scale] duration-150 ease-out active:scale-[0.96] motion-reduce:active:scale-100 md:size-10 cursor-pointer',
              active ? 'text-primary-foreground' : 'text-muted-foreground hover:text-foreground'
            )}
          >
            {active && (
              <motion.span
                layoutId="theme-toggle-pill"
                className="absolute inset-[8px] rounded-full bg-primary md:inset-1.5"
                transition={{ type: 'spring', stiffness: 380, damping: 30 }}
              />
            )}
            <Icon className="relative z-10 size-3.5" />
          </button>
        );
      })}
    </div>
  );
}
