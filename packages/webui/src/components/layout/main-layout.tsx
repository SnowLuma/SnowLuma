import { useEffect, useState, type ReactNode } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouterState } from '@tanstack/react-router';
import { Sheet, SheetContent, SheetDescription, SheetTitle } from '@/components/ui/sheet';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Sidebar } from '@/components/layout/sidebar';
import { TopBar } from '@/components/layout/top-bar';
import { useMediaQuery } from '@/hooks/use-media-query';
import { cn } from '@/lib/utils';

interface MainLayoutProps {
  status: string;
  onLogout: () => void;
  children: ReactNode;
}

export function MainLayout({ status, onLogout, children }: MainLayoutProps) {
  const isMobile = !useMediaQuery('(min-width: 768px)');
  const [collapsed, setCollapsed] = useState(() => {
    return localStorage.getItem('snowluma_sidebar_collapsed') === '1';
  });
  const [mobileOpen, setMobileOpen] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });

  useEffect(() => {
    localStorage.setItem('snowluma_sidebar_collapsed', collapsed ? '1' : '0');
  }, [collapsed]);

  return (
    <div className="flex h-screen w-screen overflow-hidden bg-background text-foreground">
      {/* Desktop sidebar */}
      {!isMobile && (
        <motion.aside
          initial={false}
          animate={{ width: collapsed ? 64 : 248 }}
          transition={{ type: 'spring', stiffness: 280, damping: 32 }}
          className="relative h-full shrink-0 border-r overflow-hidden"
        >
          <Sidebar collapsed={collapsed} />
        </motion.aside>
      )}

      {/* Mobile sidebar in sheet */}
      {isMobile && (
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

      {/* Main column */}
      <div className="flex min-w-0 flex-1 flex-col">
        <TopBar
          status={status}
          collapsed={collapsed}
          onToggleCollapse={() => setCollapsed((v) => !v)}
          onOpenMobile={() => setMobileOpen(true)}
          onLogout={onLogout}
          isMobile={isMobile}
        />

        <main className={cn('flex min-h-0 flex-1 flex-col')}>
          <ScrollArea className="flex-1 min-h-0" viewportClassName="[&>div]:!block">
            <div className="mx-auto w-full max-w-7xl px-4 py-5 sm:px-6 sm:py-6 lg:px-8 2xl:max-w-[1600px]">
              <AnimatePresence mode="wait">
                <motion.div
                  key={pathname}
                  initial={{ opacity: 0, y: 10 }}
                  animate={{ opacity: 1, y: 0 }}
                  exit={{ opacity: 0, y: -8 }}
                  transition={{ duration: 0.22, ease: [0.16, 1, 0.3, 1] }}
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
