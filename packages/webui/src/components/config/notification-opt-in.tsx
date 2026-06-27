// Per-account opt-in to the GLOBAL notification channels. Renders the channels
// defined in 设置 → 通知 as toggles; the selection maps to
// OneBotConfig.notifications.channelIds. Lives inside the account's 通用设置 tab,
// so toggling marks the config dirty and rides the parent's debounced autosave.
//
// Scales to many channels (40+): collapsed by default to a one-line summary of
// selected channels as removable chips; expanded into a searchable, bulk-
// actionable, height-bounded scroll list so it never blows up the page.
import { useEffect, useMemo, useState } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { ChevronDown, Loader2, Search, X } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { NotificationChannel } from '@/types';

interface NotificationOptInProps {
  selectedIds: string[];
  onChange: (channelIds: string[]) => void;
}

/** How many summary chips to show before collapsing the rest into "+N". */
const CHIP_CAP = 8;

export function NotificationOptIn({ selectedIds, onChange }: NotificationOptInProps) {
  const api = useApi();
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);
  const [expanded, setExpanded] = useState(false);
  const [query, setQuery] = useState('');

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.notifications.getConfig();
        if (!cancelled) setChannels(cfg.channels);
      } catch {
        if (!cancelled) setChannels([]);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const selected = useMemo(() => new Set(selectedIds), [selectedIds]);

  const toggle = (id: string, on: boolean) => {
    const set = new Set(selectedIds);
    if (on) set.add(id);
    else set.delete(id);
    // Order known channels by the global list; keep any stale ids (channel
    // deleted globally but still opted-in) at the end rather than dropping them.
    const known = (channels ?? []).map((c) => c.id).filter((cid) => set.has(cid));
    const extra = selectedIds.filter((sid) => set.has(sid) && !known.includes(sid));
    onChange([...known, ...extra]);
  };

  const selectAll = () => {
    // Only enabled channels can ever fire, so "全选" maps to those.
    onChange((channels ?? []).filter((c) => c.enabled).map((c) => c.id));
  };
  const clearAll = () => onChange([]);

  // Resolve the selected ids back to channels for the collapsed chip summary.
  // Stale ids (channel deleted globally) fall back to showing the raw id.
  const selectedChips = useMemo(() => {
    const byId = new Map((channels ?? []).map((c) => [c.id, c]));
    return selectedIds.map((id) => ({ id, name: byId.get(id)?.name || id }));
  }, [channels, selectedIds]);

  const filtered = useMemo(() => {
    const list = channels ?? [];
    const q = query.trim().toLowerCase();
    if (!q) return list;
    return list.filter((c) => (c.name || c.id).toLowerCase().includes(q) || c.url.toLowerCase().includes(q));
  }, [channels, query]);

  const total = channels?.length ?? 0;
  const selectedCount = selectedIds.length;

  return (
    <div className="flex flex-col gap-3 rounded-xl border bg-card/40 p-4">
      {/* header — toggles the editor open/closed */}
      <button
        type="button"
        aria-expanded={expanded}
        onClick={() => setExpanded((v) => !v)}
        className="flex w-full items-center justify-between gap-3 text-left"
      >
        <div className="flex min-w-0 items-center gap-2">
          <Label className="cursor-pointer text-foreground">上下线通知渠道</Label>
          {channels !== null && (
            <Badge variant={selectedCount > 0 ? 'default' : 'outline'}>
              已选 {selectedCount} / 共 {total}
            </Badge>
          )}
        </div>
        <ChevronDown
          className={cn('size-4 shrink-0 text-muted-foreground transition-transform duration-200', expanded && 'rotate-180')}
        />
      </button>

      {channels === null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> 加载渠道…
        </div>
      ) : total === 0 ? (
        <p className="text-[11px] text-muted-foreground">还没有全局渠道——先到「设置 → 通知」添加。</p>
      ) : (
        <>
          {/* collapsed: selected channels as removable chips */}
          {!expanded &&
            (selectedCount === 0 ? (
              <p className="text-[11px] text-muted-foreground">未选择任何渠道。展开以选择。</p>
            ) : (
              <div className="flex flex-wrap gap-1.5">
                {selectedChips.slice(0, CHIP_CAP).map((ch) => (
                  <Badge key={ch.id} variant="secondary" className="max-w-[12rem] pr-1">
                    <span className="truncate">{ch.name}</span>
                    <button
                      type="button"
                      onClick={() => toggle(ch.id, false)}
                      aria-label={`移除 ${ch.name}`}
                      className="ml-0.5 rounded-full p-0.5 text-muted-foreground transition-colors hover:bg-foreground/10 hover:text-foreground"
                    >
                      <X className="size-3" />
                    </button>
                  </Badge>
                ))}
                {selectedCount > CHIP_CAP && (
                  <button
                    type="button"
                    onClick={() => setExpanded(true)}
                    className="rounded-full px-2 py-0.5 text-[11px] font-medium text-muted-foreground transition-colors hover:text-foreground"
                  >
                    +{selectedCount - CHIP_CAP} 更多
                  </button>
                )}
              </div>
            ))}

          {/* expanded: search + bulk + bounded scroll list */}
          <AnimatePresence initial={false}>
            {expanded && (
              <motion.div
                initial={{ height: 0, opacity: 0 }}
                animate={{ height: 'auto', opacity: 1 }}
                exit={{ height: 0, opacity: 0 }}
                transition={{ duration: 0.22 }}
                className="overflow-hidden"
              >
                <div className="flex flex-col gap-3 pt-1">
                  <p className="text-[11px] leading-relaxed text-muted-foreground">
                    该账号上线 / 下线时向选中的渠道推送通知。渠道在「设置 → 通知」中全局定义。
                  </p>

                  <div className="flex items-center gap-2">
                    <div className="relative flex-1">
                      <Search className="pointer-events-none absolute left-2.5 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground" />
                      <Input
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        placeholder="搜索渠道…"
                        className="h-8 pl-8 text-xs"
                      />
                    </div>
                    <button
                      type="button"
                      onClick={selectAll}
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      全选
                    </button>
                    <button
                      type="button"
                      onClick={clearAll}
                      className="rounded-md px-2 py-1 text-[11px] font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
                    >
                      清空
                    </button>
                  </div>

                  {filtered.length === 0 ? (
                    <p className="py-4 text-center text-[11px] text-muted-foreground">无匹配渠道</p>
                  ) : (
                    <ScrollArea className="max-h-64 rounded-lg border bg-background/40">
                      <div className="divide-y divide-border/60">
                        {filtered.map((ch) => (
                          <div
                            key={ch.id}
                            className="flex items-center justify-between gap-3 px-3 py-2"
                          >
                            <div className="min-w-0">
                              <div className="flex items-center gap-1.5">
                                <span className="truncate text-sm">{ch.name || ch.id}</span>
                                {!ch.enabled && (
                                  <span className="shrink-0 text-[10px] text-muted-foreground">（已全局禁用）</span>
                                )}
                              </div>
                              <p className="truncate text-[11px] text-muted-foreground">{ch.url}</p>
                            </div>
                            <ToggleSwitch
                              // Globally-disabled channel: lock the switch and force it off
                              // (it can never fire, so the per-account opt-in must read off).
                              value={ch.enabled && selected.has(ch.id)}
                              onChange={(v) => toggle(ch.id, v)}
                              ariaLabel={`为该账号启用渠道 ${ch.name || ch.id}`}
                              disabled={!ch.enabled}
                            />
                          </div>
                        ))}
                      </div>
                    </ScrollArea>
                  )}
                </div>
              </motion.div>
            )}
          </AnimatePresence>
        </>
      )}
    </div>
  );
}
