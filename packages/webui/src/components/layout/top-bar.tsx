import { useState } from 'react';
import { LogOut, Menu, Monitor } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouterState } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { NAV_ITEMS } from '@/components/layout/sidebar';
import { reconcileLayoutItems, useLayout } from '@/contexts/LayoutContext';
import { useKiosk } from '@/contexts/KioskContext';

// Toggleable top-bar elements (the menu/title/logout are essential and always
// render). Labels drive the settings toggles; ids match `topbarItems`.
export const TOPBAR_CATALOGUE: { id: string; label: string }[] = [
  { id: 'status', label: '连接状态徽章' },
  { id: 'theme', label: '主题切换按钮' },
  { id: 'kiosk', label: '展示模式按钮' },
];

interface TopBarProps {
  status: string;
  onOpenMobile: () => void;
  onLogout: () => void;
  isMobile: boolean;
}

export function TopBar({
  status,
  onOpenMobile,
  onLogout,
  isMobile,
}: TopBarProps) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const meta = NAV_ITEMS.find((n) => n.to === pathname);
  const PageIcon = meta?.icon;
  const online = status === '已连接';

  // Which optional top-bar elements the operator has kept (reconciled against
  // the live catalogue, so a new element defaults to shown).
  const { topbarItems } = useLayout();
  const { enter: enterKiosk } = useKiosk();
  const shown = new Set(
    reconcileLayoutItems(topbarItems, TOPBAR_CATALOGUE.map((t) => t.id))
      .filter((i) => i.visible)
      .map((i) => i.id),
  );

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 bg-background/55 px-3 backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/45 sm:px-4">
      {/* Mobile-only menu trigger. On desktop there's no collapse button — the
          sidebar auto-expands on hover/focus, and its boundary with the content
          is a soft surface-tone shift, not a hard border. */}
      {isMobile && (
        <Button variant="ghost" size="icon-sm" onClick={onOpenMobile} aria-label="打开菜单">
          <Menu className="size-4" />
        </Button>
      )}

      {/* Page title */}
      <AnimatePresence mode="wait">
        <motion.div
          key={pathname}
          initial={{ opacity: 0, x: -8 }}
          animate={{ opacity: 1, x: 0 }}
          exit={{ opacity: 0, x: 8 }}
          transition={{ duration: 0.18 }}
          className="flex min-w-0 items-center gap-2"
        >
          {PageIcon && <PageIcon className="size-4 text-primary" />}
          <h1 className="truncate text-sm font-semibold tracking-tight">{meta?.label}</h1>
          <span className="hidden sm:inline truncate text-xs text-muted-foreground">{meta?.description}</span>
        </motion.div>
      </AnimatePresence>

      <div className="ml-auto flex items-center gap-2">
        {shown.has('status') && (
          <Badge
            variant={online ? 'success' : 'destructive'}
            className="hidden sm:inline-flex gap-1.5"
          >
            <span
              className={`size-1.5 rounded-full ${online ? 'bg-success' : 'bg-destructive'} ${online ? 'animate-pulse' : ''}`}
            />
            {status}
          </Badge>
        )}

        {shown.has('theme') && <ThemeToggle />}

        {shown.has('kiosk') && (
          <Button
            variant="ghost"
            size="icon-sm"
            onClick={enterKiosk}
            aria-label="展示模式"
            title="展示模式（隐藏侧栏与顶栏，Esc 退出）"
            className="text-muted-foreground hover:text-foreground"
          >
            <Monitor className="size-4" />
          </Button>
        )}

        <Button
          variant="ghost"
          size="icon-sm"
          onClick={() => setConfirmLogout(true)}
          aria-label="登出"
          title="登出"
          className="text-muted-foreground hover:text-destructive"
        >
          <LogOut className="size-4" />
        </Button>
      </div>

      <ConfirmDialog
        open={confirmLogout}
        onOpenChange={setConfirmLogout}
        title="确认登出？"
        description="登出后将清除当前会话令牌，您需要重新输入访问密码才能进入控制台。"
        confirmText="登出"
        destructive
        onConfirm={onLogout}
      />
    </header>
  );
}
