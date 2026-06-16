// Per-account opt-in to the GLOBAL notification channels. Renders the channels
// defined in 设置 → 通知 as toggles; the selection maps to
// OneBotConfig.notifications.channelIds. Lives inside the account's 通用设置 tab,
// so toggling marks the config dirty and rides the parent's debounced autosave.
import { useEffect, useState } from 'react';
import { Loader2 } from 'lucide-react';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { useApi } from '@/lib/api';
import type { NotificationChannel } from '@/types';

interface NotificationOptInProps {
  selectedIds: string[];
  onChange: (channelIds: string[]) => void;
}

export function NotificationOptIn({ selectedIds, onChange }: NotificationOptInProps) {
  const api = useApi();
  const [channels, setChannels] = useState<NotificationChannel[] | null>(null);

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

  const selected = new Set(selectedIds);

  return (
    <div className="flex flex-col gap-3 rounded-lg border bg-card/40 p-4">
      <div>
        <Label>上下线通知渠道</Label>
        <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
          该账号上线 / 下线时向选中的渠道推送通知。渠道在「设置 → 通知」中全局定义。
        </p>
      </div>

      {channels === null ? (
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="size-3.5 animate-spin" /> 加载渠道…
        </div>
      ) : channels.length === 0 ? (
        <p className="text-[11px] text-muted-foreground">还没有全局渠道——先到「设置 → 通知」添加。</p>
      ) : (
        <div className="flex flex-col divide-y">
          {channels.map((ch) => (
            <div key={ch.id} className="flex items-center justify-between gap-3 py-2 first:pt-0 last:pb-0">
              <div className="min-w-0">
                <span className="text-sm">{ch.name || ch.id}</span>
                {!ch.enabled && <span className="ml-2 text-[10px] text-muted-foreground">（已全局禁用）</span>}
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
      )}
    </div>
  );
}
