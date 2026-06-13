// Account selector strip. Collapsing to a 56px avatar-only column keeps
// the right-side editor breathing on smaller screens; expanded it shows
// nickname + UIN like the original. Selection routes through
// `requestSwitchUin` so the dirty-modify guard still gates the switch.

import { motion } from 'motion/react';
import { ChevronLeft, ChevronRight } from 'lucide-react';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Button } from '@/components/ui/button';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger } from '@/components/ui/tooltip';
import { cn } from '@/lib/utils';
import type { QQInfo } from '@/types';

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

interface AccountSidebarProps {
  accounts: QQInfo[];
  selectedUin: string | null;
  onSelect: (uin: string) => void;
  collapsed: boolean;
  onToggleCollapsed: () => void;
}

export function AccountSidebar({
  accounts,
  selectedUin,
  onSelect,
  collapsed,
  onToggleCollapsed,
}: AccountSidebarProps) {
  return (
    <motion.aside
      animate={{ width: collapsed ? 56 : 248 }}
      transition={{ type: 'spring', stiffness: 300, damping: 32 }}
      className="shrink-0 rounded-xl border bg-card/40"
    >
      <div className={cn('flex items-center', collapsed ? 'justify-center px-1.5 py-2' : 'justify-between px-3 py-2')}>
        {!collapsed && <span className="text-xs font-medium text-muted-foreground">在线连接</span>}
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onToggleCollapsed}
          aria-label={collapsed ? '展开账号列表' : '收起账号列表'}
          className="text-muted-foreground"
        >
          {collapsed ? <ChevronRight className="size-4" /> : <ChevronLeft className="size-4" />}
        </Button>
      </div>

      {accounts.length === 0 ? (
        <p className={cn('py-6 text-center text-xs text-muted-foreground', collapsed && 'px-1')}>
          {collapsed ? '—' : '暂无在线会话'}
        </p>
      ) : (
        <ScrollArea className="max-h-[70vh]" viewportClassName="[&>div]:!block">
          <TooltipProvider delayDuration={300}>
            <div className={cn('flex flex-col gap-1', collapsed ? 'px-1.5 pb-2' : 'px-2 pb-2')}>
              {accounts.map((q) => {
                const isActive = selectedUin === q.uin;
                const button = (
                  <motion.button
                    key={q.uin}
                    type="button"
                    whileHover={{ scale: 1.01 }}
                    whileTap={{ scale: 0.98 }}
                    onClick={() => onSelect(q.uin)}
                    className={cn(
                      'flex items-center gap-2.5 rounded-lg border text-left transition-colors cursor-pointer',
                      collapsed ? 'justify-center p-1.5' : 'px-2.5 py-2',
                      isActive ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-accent/40',
                    )}
                  >
                    <Avatar size={collapsed ? 32 : 28}>
                      <AvatarImage src={qqAvatarUrl(q.uin)} alt={q.nickname || q.uin} />
                      <AvatarFallback>{(q.nickname || q.uin).slice(0, 2)}</AvatarFallback>
                    </Avatar>
                    {!collapsed && (
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn('truncate text-sm font-medium', isActive ? 'text-primary' : 'text-foreground')}
                        >
                          {q.nickname || q.uin}
                        </div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground tabular-nums">
                          {q.uin}
                        </div>
                      </div>
                    )}
                  </motion.button>
                );
                return collapsed ? (
                  <Tooltip key={q.uin}>
                    <TooltipTrigger asChild>{button}</TooltipTrigger>
                    <TooltipContent side="right" sideOffset={8}>
                      <div className="flex flex-col leading-tight">
                        <span className="font-medium">{q.nickname || q.uin}</span>
                        <span className="font-mono text-[10px] text-muted-foreground tabular-nums">{q.uin}</span>
                      </div>
                    </TooltipContent>
                  </Tooltip>
                ) : (
                  button
                );
              })}
            </div>
          </TooltipProvider>
        </ScrollArea>
      )}
    </motion.aside>
  );
}
