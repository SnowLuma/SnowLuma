// Overview widget: the notification subsystem's in-memory delivery history
// (most-recent-first, lost on restart). Opt-in (hidden by default); polls
// /api/notifications/recent. No per-widget config.
import { useEffect, useState } from 'react';
import { Bell, CheckCircle2, XCircle } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { cn } from '@/lib/utils';
import { useApi } from '@/lib/api';
import { useTheme } from '@/contexts/ThemeContext';
import type { NotificationDeliveryRecord } from '@/types';

const POLL_MS = 15_000;

export function DeliveriesWidget() {
  const api = useApi();
  const { formatClock } = useTheme();
  const [records, setRecords] = useState<NotificationDeliveryRecord[] | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    let active = true;
    let inFlight = false;
    const pull = () => {
      // Skip while the tab is backgrounded, or if a request is still in flight
      // (a slow endpoint must not stack overlapping polls). #185.
      if (inFlight || document.hidden) return;
      inFlight = true;
      api.notifications
        .recent(50)
        .then((r) => {
          if (active) {
            setLoadError(null);
            setRecords(r);
          }
        })
        .catch((error) => {
          console.error('load recent notification deliveries failed', error);
          if (active) {
            setLoadError(error instanceof Error ? error.message : '加载最近投递失败');
            setRecords((prev) => prev ?? []);
          }
        })
        .finally(() => { inFlight = false; });
    };
    void pull();
    const id = window.setInterval(() => void pull(), POLL_MS);
    // The interval keeps firing but no-ops while hidden, so refresh immediately
    // when the tab becomes visible again to shed any staleness.
    const onVisible = () => { if (!document.hidden) pull(); };
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      active = false;
      window.clearInterval(id);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [api]);

  return (
    <Card className="flex h-full flex-col">
      <CardHeader className="flex flex-row items-center gap-2 space-y-0">
        <CardTitle className="flex items-center gap-2">
          <Bell className="size-4 text-primary" /> 最近投递
        </CardTitle>
      </CardHeader>
      <CardContent className="min-h-0 flex-1 overflow-auto">
        <SkeletonSwap
          ready={records !== null}
          reserve={120}
          lines={5}
          lineHeight={24}
          label="最近投递"
          className={records !== null ? 'skeleton-swap-fluid min-h-[120px]' : ''}
        >
          {records !== null ? (
            loadError && records.length === 0 ? (
              <p role="alert" className="rounded-xl border border-destructive/30 bg-destructive/10 px-3 py-8 text-center text-sm text-destructive">
                {loadError}
              </p>
            ) : records.length === 0 ? (
              <div className="flex flex-col items-center justify-center gap-2 rounded-xl border border-dashed py-10 text-muted-foreground">
                <Bell className="size-8 opacity-40" strokeWidth={1.5} />
                <p className="text-sm">暂无投递记录</p>
              </div>
            ) : (
              <div className="flex flex-col gap-1 text-meta">
                {loadError && (
                  <p role="alert" className="mb-1 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 font-sans text-xs text-destructive">
                    {loadError}；当前显示上次成功读取的投递记录。
                  </p>
                )}
                {records.map((r, i) => (
                  <div key={i} className="flex items-center gap-2 rounded px-2 py-1 hover:bg-accent/30">
                    {r.ok ? (
                      <CheckCircle2 className="size-3.5 shrink-0 text-emerald-500" />
                    ) : (
                      <XCircle className="size-3.5 shrink-0 text-destructive" />
                    )}
                    <span className="shrink-0 font-mono tabular-nums text-muted-foreground">{formatClock(r.time)}</span>
                    <span
                      className={cn(
                        'shrink-0 font-medium',
                        r.event === 'online' ? 'text-emerald-600' : 'text-amber-600',
                      )}
                    >
                      {r.event === 'online' ? '上线' : '下线'}
                    </span>
                    <span className="shrink-0 font-mono">{r.uin}</span>
                    <span className="ml-auto min-w-0 truncate text-muted-foreground" title={r.error ?? r.channelId}>
                      {r.channelId}
                      {!r.ok && r.error && <span className="text-xs text-destructive"> · {r.error}</span>}
                    </span>
                  </div>
                ))}
              </div>
            )
          ) : null}
        </SkeletonSwap>
      </CardContent>
    </Card>
  );
}
