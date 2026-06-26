import { Bug, Check, Eye, EyeOff, GripVertical, LayoutDashboard, Lock, PlugZap, Settings, Sparkles, SlidersHorizontal, Terminal } from 'lucide-react';
import { motion, Reorder } from 'motion/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { APP_NAME, APP_VERSION } from '@/types';
import { useAppState } from '@/contexts/AppStateContext';
import { reconcileLayoutItems, useLayout } from '@/contexts/LayoutContext';
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
  { to: '/debug', label: '调试', icon: Bug, description: '测试台与实时活动' },
  { to: '/settings', label: '系统设置', icon: SlidersHorizontal, description: '主题与账号' },
];

// Anti-self-lock: these nav items can be reordered but never hidden.
//   '/'        — hosts the 「编辑布局」 entry point; hiding it would strand the
//                user with no way back to un-hide anything.
//   '/settings'— account + appearance.
export const PINNED_NAV: AppPath[] = ['/', '/settings'];

interface SidebarProps {
  collapsed?: boolean;
  onItemClick?: () => void;
}

export function Sidebar({ collapsed = false, onItemClick }: SidebarProps) {
  const pathname = useRouterState({ select: (s) => s.location.pathname });
  const { updateInfo } = useAppState();
  const { navItems, setNavItems, editing, setEditing } = useLayout();

  // Full reconciled nav (incl. hidden) — pinned forced visible, forward-compat.
  const reconciled = reconcileLayoutItems(navItems, NAV_ITEMS.map((i) => i.to), PINNED_NAV);
  // View mode: configured order, hidden removed.
  const orderedNav = reconciled
    .filter((i) => i.visible)
    .map((i) => NAV_ITEMS.find((n) => n.to === i.id))
    .filter((n): n is NavItem => !!n);

  const reorderNav = (ids: string[]) => {
    const byId = new Map(reconciled.map((i) => [i.id, i]));
    setNavItems(ids.map((id) => byId.get(id)).filter((x): x is NonNullable<typeof x> => !!x));
  };
  const toggleNav = (id: string) =>
    setNavItems(reconciled.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)));

  return (
    <div className="flex h-full w-full flex-col bg-sidebar text-sidebar-foreground">
      {/* Brand */}
      <div className={cn('flex h-16 items-center gap-3 px-4', collapsed && 'justify-center px-2')}>
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
        {editing ? (
          <div className="flex flex-col gap-2 p-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-[11px] font-medium text-muted-foreground">编辑导航</span>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-0.5 text-[11px] text-primary transition-colors hover:bg-primary/20 cursor-pointer"
              >
                <Check className="size-3" /> 完成
              </button>
            </div>
            <Reorder.Group axis="y" values={reconciled.map((i) => i.id)} onReorder={reorderNav} className="flex flex-col gap-1">
              {reconciled.map((item) => {
                const meta = NAV_ITEMS.find((n) => n.to === item.id);
                if (!meta) return null;
                const Icon = meta.icon;
                const pinned = (PINNED_NAV as string[]).includes(item.id);
                return (
                  <Reorder.Item
                    key={item.id}
                    value={item.id}
                    className={cn(
                      'flex select-none items-center gap-2 rounded-lg bg-sidebar-accent/40 px-2 py-2 cursor-grab active:cursor-grabbing',
                      !item.visible && 'opacity-50',
                    )}
                  >
                    <GripVertical className="size-3.5 shrink-0 text-muted-foreground" />
                    <Icon className="size-4 shrink-0 text-muted-foreground" />
                    <span className="min-w-0 flex-1 truncate text-sm">{meta.label}</span>
                    {pinned ? (
                      <span title="必选项，不可隐藏" className="inline-flex size-7 items-center justify-center text-muted-foreground/50">
                        <Lock className="size-3.5" />
                      </span>
                    ) : (
                      <button
                        type="button"
                        onClick={() => toggleNav(item.id)}
                        title={item.visible ? '隐藏' : '显示'}
                        aria-label={item.visible ? '隐藏' : '显示'}
                        className="inline-flex size-7 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-sidebar-accent/50 hover:text-foreground cursor-pointer"
                      >
                        {item.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                      </button>
                    )}
                  </Reorder.Item>
                );
              })}
            </Reorder.Group>
          </div>
        ) : (
          <nav className={cn('flex flex-col gap-1 p-2', collapsed && 'items-center')}>
            {orderedNav.map(({ to, label, icon: Icon, description }) => {
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
                    <>
                      <motion.span
                        layoutId="sidebar-active-pill"
                        className="absolute inset-0 rounded-lg bg-sidebar-accent"
                        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      />
                      <motion.span
                        layoutId="sidebar-active-bar"
                        className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      />
                    </>
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
        )}
      </ScrollArea>

      {updateInfo?.hasUpdate && (
        <div className={cn('px-2 pt-2', collapsed && 'px-0')}>
          <Link
            to="/settings"
            search={{ tab: 'about' }}
            onClick={onItemClick}
            title={updateInfo.latest ? `有新版本 v${updateInfo.latest} · 点击查看` : '有可用更新'}
            aria-label="有可用更新"
            className={cn(
              'group relative flex items-center gap-2.5 rounded-lg bg-primary/[0.1] px-3 py-2 text-left transition-colors hover:bg-primary/15',
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
