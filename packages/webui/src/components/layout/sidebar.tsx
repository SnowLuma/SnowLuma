import { LayoutDashboard, PlugZap, Settings, Sparkles, SlidersHorizontal, Terminal } from 'lucide-react';
import { motion } from 'motion/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Separator } from '@/components/ui/separator';
import { cn } from '@/lib/utils';
import { APP_NAME, APP_VERSION } from '@/types';
import { useAppState } from '@/contexts/AppStateContext';
import type { AppPath } from '@/router';

export interface NavItem {
  to: AppPath;
  label: string;
  icon: typeof LayoutDashboard;
  description: string;
}

export const NAV_ITEMS: NavItem[] = [
  { to: '/', label: '总览', icon: LayoutDashboard, description: '主机与服务状态' },
  { to: '/processes', label: '进程注入', icon: PlugZap, description: '加载 / 卸载 / 登录' },
  { to: '/config', label: '节点配置', icon: Settings, description: 'OneBot 协议端点' },
  { to: '/logs', label: '日志', icon: Terminal, description: '实时事件流' },
  { to: '/settings', label: '系统设置', icon: SlidersHorizontal, description: '主题与账号' },
];

interface SidebarProps {
  collapsed?: boolean;
  onItemClick?: () => void;
}

export function Sidebar({ collapsed = false, onItemClick }: SidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { updateInfo } = useAppState();

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className={cn('flex h-16 items-center gap-3 border-b px-4', collapsed && 'justify-center px-2')}>
        <div className="relative flex size-9 shrink-0 items-center justify-center overflow-hidden rounded-xl bg-primary/10 ring-1 ring-primary/20">
          <img src="/logo.png" alt="SnowLuma" className="size-7 object-contain" />
        </div>
        {!collapsed && (
          <div className="min-w-0 flex-1">
            <div className="flex items-baseline gap-1.5">
              <span className="text-sm font-bold tracking-tight">{APP_NAME}</span>
              <span className="text-[10px] font-medium text-muted-foreground tabular-nums">v{APP_VERSION}</span>
            </div>
            <span className="text-[10px] text-muted-foreground">OneBot v11 控制台</span>
          </div>
        )}
      </div>

      {/* Nav */}
      <ScrollArea className="flex-1 min-h-0" viewportClassName="[&>div]:!block">
        <nav className={cn('flex flex-col gap-1 p-2', collapsed && 'items-center')}>
          {NAV_ITEMS.map(({ to, label, icon: Icon, description }) => {
            const isActive = pathname === to;
            return (
              <Link
                key={to}
                to={to}
                title={collapsed ? label : undefined}
                onClick={onItemClick}
                aria-current={isActive ? 'page' : undefined}
                className={cn(
                  'group relative flex w-full items-center gap-3 rounded-lg px-3 py-2.5 text-sm font-medium transition-colors cursor-pointer outline-none',
                  collapsed && 'w-10 justify-center px-0',
                  isActive
                    ? 'text-sidebar-accent-foreground'
                    : 'text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground',
                )}
              >
                {isActive && (
                  <motion.span
                    layoutId="sidebar-active-pill"
                    className="absolute inset-0 rounded-lg bg-sidebar-accent ring-1 ring-primary/20"
                    transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                  />
                )}
                <Icon className={cn('relative z-10 size-4 shrink-0', isActive && 'text-primary')} />
                {!collapsed && (
                  <span className="relative z-10 flex min-w-0 flex-1 flex-col items-start">
                    <span className="truncate leading-tight">{label}</span>
                    <span className="text-[10px] font-normal text-muted-foreground truncate">{description}</span>
                  </span>
                )}
              </Link>
            );
          })}
        </nav>
      </ScrollArea>

      <Separator />
      {updateInfo?.hasUpdate && (
        <div className={cn('px-2 pt-2', collapsed && 'px-0')}>
          <Link
            to="/settings"
            onClick={onItemClick}
            title={updateInfo.latest ? `有新版本 v${updateInfo.latest} · 点击查看` : '有可用更新'}
            aria-label="有可用更新"
            className={cn(
              'group relative flex items-center gap-2.5 rounded-lg border border-primary/30 bg-primary/[0.07] px-3 py-2 text-left transition-colors hover:bg-primary/10',
              collapsed && 'mx-auto w-10 justify-center px-0',
            )}
          >
            <Sparkles className="size-4 shrink-0 text-primary" />
            {!collapsed && (
              <span className="flex min-w-0 flex-1 flex-col">
                <span className="text-xs font-medium leading-tight text-foreground">有新版本可用</span>
                <span className="truncate text-[10px] text-muted-foreground">v{updateInfo.latest} · 点击查看</span>
              </span>
            )}
            {collapsed && (
              <span className="absolute right-1 top-1 size-2 rounded-full border-2 border-sidebar bg-primary" />
            )}
          </Link>
        </div>
      )}
      <div className={cn('px-4 py-3 text-[10px] text-muted-foreground', collapsed && 'text-center px-2')}>
        {collapsed ? '©' : `© ${new Date().getFullYear()} SnowLuma`}
      </div>
    </div>
  );
}
