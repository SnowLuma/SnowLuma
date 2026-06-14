import { useState } from 'react';
import { LogOut, Menu, PanelLeftClose, PanelLeftOpen } from 'lucide-react';
import { motion, AnimatePresence } from 'motion/react';
import { useRouterState } from '@tanstack/react-router';
import { Button } from '@/components/ui/button';
import { Badge } from '@/components/ui/badge';
import { ThemeToggle } from '@/components/theme-toggle';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { NAV_ITEMS } from '@/components/layout/sidebar';

interface TopBarProps {
  status: string;
  collapsed: boolean;
  onToggleCollapse: () => void;
  onOpenMobile: () => void;
  onLogout: () => void;
  isMobile: boolean;
  /** Layout edit mode force-expands the sidebar, so collapsing is disabled. */
  editing?: boolean;
}

export function TopBar({
  status,
  collapsed,
  onToggleCollapse,
  onOpenMobile,
  onLogout,
  isMobile,
  editing = false,
}: TopBarProps) {
  const [confirmLogout, setConfirmLogout] = useState(false);
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const meta = NAV_ITEMS.find((n) => n.to === pathname);
  const PageIcon = meta?.icon;
  const online = status === '已连接';

  return (
    <header className="sticky top-0 z-30 flex h-16 shrink-0 items-center gap-2 border-b bg-background/55 px-3 backdrop-blur-xl backdrop-saturate-150 supports-[backdrop-filter]:bg-background/45 sm:px-4">
      {/* Collapse toggle (desktop) / menu (mobile) */}
      {isMobile ? (
        <Button variant="ghost" size="icon-sm" onClick={onOpenMobile} aria-label="打开菜单">
          <Menu className="size-4" />
        </Button>
      ) : (
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapse}
          disabled={editing}
          aria-label={collapsed ? '展开侧边栏' : '收起侧边栏'}
          title={editing ? '编辑布局时侧栏保持展开' : collapsed ? '展开侧边栏' : '收起侧边栏'}
        >
          {collapsed ? <PanelLeftOpen className="size-4" /> : <PanelLeftClose className="size-4" />}
        </Button>
      )}

      <div className="mx-1 h-6 w-px bg-border" />

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
        <Badge
          variant={online ? 'success' : 'destructive'}
          className="hidden sm:inline-flex gap-1.5"
        >
          <span
            className={`size-1.5 rounded-full ${online ? 'bg-success' : 'bg-destructive'} ${online ? 'animate-pulse' : ''}`}
          />
          {status}
        </Badge>

        <ThemeToggle />

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
