import { useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouterState } from '@tanstack/react-router';
import { Minimize2 } from 'lucide-react';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { useMediaQuery } from '@/hooks/use-media-query';
import { useTheme } from '@/contexts/ThemeContext';
import { useLayout } from '@/contexts/LayoutContext';
import { useKiosk } from '@/contexts/KioskContext';
import { cn } from '@/lib/utils';

interface MainLayoutProps {
  status: string;
  onLogout: () => void;
  children: ReactNode;
}

export function MainLayout({ status, onLogout, children }: MainLayoutProps) {
  const isMobile = !useMediaQuery('(min-width: 768px)');
  const { appearance } = useTheme();
  const customBg = appearance.background.type !== 'none';
  // Framer's reducedMotion only suppresses transforms, so the always-present
  // width + page-transition animations need an explicit opt-out to make the
  // “减少动效” setting actually felt.
  const reduce = appearance.reduceMotion || appearance.disableMotion;
  const { editing } = useLayout();
  const { kiosk, exit: exitKiosk } = useKiosk();
  // The sidebar rests as a slim icon rail and auto-expands on hover/focus (the
  // peek logic below) — there's no collapse button. Two cases force it fully
  // expanded: layout-edit mode (the drag-to-reorder list needs room) and the
  // 「钉住侧栏展开」 appearance pref (operator opted out of the rail entirely).
  const effectiveCollapsed = !editing && !appearance.sidebarPinned;
  // Hover/focus peek: while collapsed, hovering (or keyboard-focusing) the rail
  // temporarily expands it. The rail lives in the flex flow, so the page
  // content is pushed right rather than overlaid. The pinned `collapsed` pref
  // (and the TopBar toggle that reflects it) is untouched — this is transient.
  const [hovered, setHovered] = useState(false);
  const [focused, setFocused] = useState(false);
  const peeking = hovered || focused;
  const showCollapsed = effectiveCollapsed && !peeking;
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  return (
    <div className={cn('flex h-screen w-screen overflow-hidden text-foreground', customBg ? 'bg-transparent' : 'bg-sidebar')}>
      {/* Desktop sidebar (hidden in kiosk) */}
      {!isMobile && !kiosk && (
        <motion.aside
          initial={false}
          animate={{ width: showCollapsed ? 64 : 248 }}
          transition={reduce ? { duration: 0 } : { duration: 0.26, ease: [0.4, 0, 0.1, 1] }}
          onMouseEnter={() => setHovered(true)}
          onMouseLeave={() => setHovered(false)}
          onFocusCapture={(e) => {
            // Only *keyboard* focus (focus-visible) peeks the rail open. A mouse
            // click on a nav link also focuses it, but must NOT peek — that
            // click-focus lingers and never blurs when the pointer moves to the
            // content, so the rail would stay stuck open after navigating.
            if ((e.target as HTMLElement).matches?.(':focus-visible')) setFocused(true);
          }}
          onBlur={(e) => {
            if (!e.currentTarget.contains(e.relatedTarget as Node)) setFocused(false);
          }}
          className="relative h-full shrink-0 overflow-hidden"
        >
          <Sidebar collapsed={showCollapsed} />
        </motion.aside>
      )}

      {/* Mobile sidebar in sheet (hidden in kiosk) */}
      {isMobile && !kiosk && (
        <Sheet open={mobileOpen} onOpenChange={setMobileOpen}>
          <SheetContent side="left" className="w-64 max-w-[80vw] p-0">
            {/* Radix Dialog (the Sheet primitive) requires an accessible name +
                description; the nav itself is the visible content, so these are
                screen-reader-only. */}
            <SheetTitle className="sr-only">导航菜单</SheetTitle>
            <SheetDescription className="sr-only">切换 SnowLuma 控制台的页面。</SheetDescription>
            <Sidebar onItemClick={() => setMobileOpen(false)} />
          </SheetContent>
        </Sheet>
      )}

      {/* Kiosk: chrome-free, with a corner button (+ Esc) to exit. */}
      {kiosk && (
        <button
          type="button"
          onClick={exitKiosk}
          title="退出展示模式 (Esc)"
          aria-label="退出展示模式"
          className="fixed right-3 top-3 z-50 inline-flex size-9 items-center justify-center rounded-full border bg-background/70 text-muted-foreground opacity-30 backdrop-blur transition-opacity outline-none hover:opacity-100 focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <Minimize2 className="size-4" />
        </button>
      )}

      {/* Main column — a content "canvas" nested into the chrome with a rounded
          top-left corner at the sidebar/topbar junction. It's a flex sibling of
          the rail, so as the rail expands/collapses the whole canvas (and its
          rounded corner) is pushed along with it. Depth comes from a soft shadow
          + the canvas tone sitting on the (sidebar-toned) chrome, not a border. */}
      <div
        className={cn(
          'flex min-w-0 flex-1 flex-col overflow-hidden rounded-tl-2xl',
          !customBg && 'bg-background shadow-[0_0_18px_-6px_rgb(0_0_0/0.14)]',
        )}
      >
        {!kiosk && (
          <TopBar
            status={status}
            onOpenMobile={() => setMobileOpen(true)}
            onLogout={onLogout}
            isMobile={isMobile}
          />
        )}

        <main className={cn('flex min-h-0 flex-1 flex-col')}>
          <ScrollArea className="flex-1 min-h-0" viewportClassName="[&>div]:!block">
            <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 2xl:max-w-[1600px]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={pathname}
                  initial={reduce ? false : { opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
                  transition={reduce ? { duration: 0 } : { duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
                >
                  {children}
                </motion.div>
              </AnimatePresence>
            </div>
          </ScrollArea>
        </main>
      </div>
    </div>
  );
}
