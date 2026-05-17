import { Toaster as Sonner, toast, type ToasterProps } from 'sonner';

/**
 * SnowLuma-themed toaster. Uses the Tailwind `--*-foreground / --background`
 * tokens defined in `@snowluma/ui/styles/theme.css` so toasts match the
 * surrounding chrome in both light and dark mode.
 */
export function Toaster(props: ToasterProps) {
  return (
    <Sonner
      position="bottom-right"
      richColors
      closeButton
      theme="system"
      toastOptions={{
        classNames: {
          toast: 'group toast group-[.toaster]:bg-card group-[.toaster]:text-card-foreground group-[.toaster]:border-border group-[.toaster]:shadow-lg',
          description: 'group-[.toast]:text-muted-foreground',
          actionButton: 'group-[.toast]:bg-primary group-[.toast]:text-primary-foreground',
          cancelButton: 'group-[.toast]:bg-muted group-[.toast]:text-muted-foreground',
        },
      }}
      {...props}
    />
  );
}

export { toast };
export type { ToasterProps };
