import { Bug, Check, Eye, EyeOff, GripVertical, LayoutDashboard, Lock, Pin, PinOff, PlugZap, Settings, Sparkles, SlidersHorizontal, Terminal } from 'lucide-react';
import { motion, Reorder } from 'motion/react';
import { Link, useRouterState } from '@tanstack/react-router';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { APP_NAME, APP_VERSION } from '@/types';
import { useAppState } from '@/contexts/AppStateContext';
import { useTheme } from '@/contexts/ThemeContext';
import { reconcileLayoutItems, useLayout } from '@/contexts/LayoutContext';
import { useMediaQuery } from '@/hooks/use-media-query';
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
  const { appearance, setAppearance } = useTheme();
  const isDesktop = useMediaQuery('(min-width: 768px)');
  const pinned = appearance.sidebarPinned;

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
    <div className="flex h-full w-full flex-col overflow-hidden bg-sidebar text-sidebar-foreground">
      {/* Brand — logo sits in a fixed 48px column centred in the collapsed
          rail; the wordmark to its right is clipped (never unmounted) when the
          rail narrows. */}
      <div className="flex h-16 shrink-0 items-center px-2">
        <div className="grid w-12 shrink-0 place-items-center">
          <div className="relative flex size-9 items-center justify-center overflow-hidden rounded-xl bg-primary/10 ring-1 ring-primary/20">
            <img src="/logo.png" alt="SnowLuma" className="size-7 object-contain" />
          </div>
        </div>
        <div className={cn('min-w-0 flex-1 overflow-hidden pr-2 transition-opacity duration-200', collapsed ? 'opacity-0' : 'opacity-100')}>
          <div className="flex items-baseline gap-1.5 whitespace-nowrap">
            <span className="text-sm font-bold tracking-tight">{APP_NAME}</span>
            <span className="text-micro font-medium text-muted-foreground tabular-nums">v{APP_VERSION}</span>
          </div>
          <span className="block whitespace-nowrap text-xs text-muted-foreground">OneBot v11 控制台</span>
        </div>
      </div>

      {/* Nav */}
      <ScrollArea className="flex-1 min-h-0" viewportClassName="[&>div]:!block">
        {editing ? (
          <div className="flex flex-col gap-2 p-2">
            <div className="flex items-center justify-between px-1">
              <span className="text-xs font-medium text-muted-foreground">编辑导航</span>
              <button
                type="button"
                onClick={() => setEditing(false)}
                className="inline-flex items-center gap-1 rounded-md bg-primary/15 px-2 py-0.5 text-xs text-primary transition-colors hover:bg-primary/20 cursor-pointer"
              >
                <Check className="size-3" /> 完成
              </button>
            </div>
            <Reorder.Group axis="y" values={reconciled.map((i) => i.id)} onReorder={reorderNav} className="flex flex-col gap-1">
              {reconciled.map((item) => {
                const meta = NAV_ITEMS.find((n) => n.to === item.id);
                if (!meta) return null;
                const Icon = meta.icon;
                const itemPinned = (PINNED_NAV as string[]).includes(item.id);
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
                    {itemPinned ? (
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
          <nav className="flex flex-col gap-1 px-2 py-2">
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
                    'group relative flex items-center rounded-lg py-2.5 text-sm font-medium transition-colors cursor-pointer outline-none',
                    isActive
                      ? 'text-sidebar-accent-foreground'
                      : 'text-muted-foreground hover:bg-sidebar-accent/40 hover:text-foreground',
                  )}
                >
                  {isActive && (
                    <>
                      {/* Highlight geometry is the ONLY thing that switches on
                          collapse: a full-row pill when open, a centred squircle
                          on the rail. Both are absolutely positioned, so they
                          morph (layout) without reflowing the row. */}
                      <motion.span
                        layoutId="sidebar-active-pill"
                        className={cn(
                          'absolute inset-y-0 rounded-lg bg-sidebar-accent',
                          collapsed ? 'left-0.5 w-11' : 'inset-x-0',
                        )}
                        transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                      />
                      {!collapsed && (
                        <motion.span
                          layoutId="sidebar-active-bar"
                          className="absolute left-0 top-1/2 h-5 w-0.5 -translate-y-1/2 rounded-full bg-primary"
                          transition={{ type: 'spring', stiffness: 380, damping: 32 }}
                        />
                      )}
                    </>
                  )}
                  <span className="relative z-10 grid w-12 shrink-0 place-items-center">
                    <Icon className={cn('size-4', isActive && 'text-primary')} />
                  </span>
                  <span className={cn('relative z-10 flex min-w-0 flex-1 flex-col items-start overflow-hidden pr-3 transition-opacity duration-200', collapsed ? 'opacity-0' : 'opacity-100')}>
                    <span className="w-full truncate whitespace-nowrap leading-tight">{label}</span>
                    <span className="w-full truncate whitespace-nowrap text-xs font-normal text-muted-foreground">{description}</span>
                  </span>
                </Link>
              );
            })}
          </nav>
        )}
      </ScrollArea>

      {updateInfo?.hasUpdate && (
        <div className="shrink-0 px-2 pb-1">
          <Link
            to="/settings"
            search={{ tab: 'about' }}
            onClick={onItemClick}
            title={collapsed ? (updateInfo.latest ? `有新版本 v${updateInfo.latest} · 点击查看` : '有可用更新') : undefined}
            aria-label="有可用更新"
            className="group relative flex items-center py-2"
          >
            {/* Background as an absolute layer so the collapsed rail shows a
                centred squircle, not a full-width bar cut off with a hard edge. */}
            <span
              className={cn(
                'absolute inset-y-0 rounded-lg bg-primary/10 transition-colors group-hover:bg-primary/[0.15]',
                collapsed ? 'left-0.5 w-11' : 'inset-x-0',
              )}
            />
            <span className="relative z-10 grid w-12 shrink-0 place-items-center"><Sparkles className="size-4 text-primary" /></span>
            <span className={cn('relative z-10 flex min-w-0 flex-1 flex-col overflow-hidden pr-3 transition-opacity duration-200', collapsed ? 'opacity-0' : 'opacity-100')}>
              <span className="truncate whitespace-nowrap text-xs font-medium leading-tight text-foreground">有新版本可用</span>
              <span className="truncate whitespace-nowrap text-xs text-muted-foreground">v{updateInfo.latest} · 点击查看</span>
            </span>
          </Link>
        </div>
      )}

      {/* Footer: © + the pin toggle (desktop only). Pinning keeps the rail
          expanded; unpinning returns it to the hover-to-peek rail. Mirrors the
          「钉住侧栏展开」 appearance setting. */}
      <div className={cn('flex shrink-0 items-center gap-2 py-3 pl-4 pr-2.5 transition-opacity duration-200', collapsed ? 'opacity-0' : 'opacity-100')}>
        <span className="min-w-0 flex-1 truncate whitespace-nowrap text-micro text-muted-foreground">
          © {new Date().getFullYear()} SnowLuma
        </span>
        {isDesktop && (
          <button
            type="button"
            onClick={() => setAppearance({ sidebarPinned: !pinned })}
            title={pinned ? '取消钉住（恢复悬停展开）' : '钉住侧栏（保持展开）'}
            aria-label={pinned ? '取消钉住侧栏' : '钉住侧栏'}
            aria-pressed={pinned}
            tabIndex={collapsed ? -1 : 0}
            className={cn(
              'inline-flex size-7 shrink-0 items-center justify-center rounded-md transition-colors cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
              pinned
                ? 'bg-primary/10 text-primary hover:bg-primary/15'
                : 'text-muted-foreground hover:bg-sidebar-accent/50 hover:text-foreground',
            )}
          >
            {pinned ? <Pin className="size-3.5" /> : <PinOff className="size-3.5" />}
          </button>
        )}
      </div>
    </div>
  );
}
