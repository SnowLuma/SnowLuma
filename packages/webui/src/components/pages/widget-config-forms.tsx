import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import { ALL_LOG_LEVELS, parseAlertsConfig, parseSessionsConfig } from '@/lib/dashboard-layout';

// Per-widget config forms, shown inside a dialog opened from a dashboard
// widget's edit-overlay gear. `config` is the widget's opaque block.config;
// `onChange` merges a partial back via setBlockConfig.

type SortOpt = 'recent' | 'uin' | 'nickname';
const SORT_LABELS: Record<SortOpt, string> = { recent: '最近', uin: 'QQ 号', nickname: '昵称' };

interface FormProps {
  config: Record<string, unknown> | undefined;
  onChange: (c: Record<string, unknown>) => void;
}

export function AlertsConfigForm({ config, onChange }: FormProps) {
  const c = parseAlertsConfig(config);
  return (
    <div className="flex flex-col gap-4">
      <label className="flex items-center justify-between gap-3 text-sm">
        <span className="text-muted-foreground">显示条数</span>
        <Input
          type="number" min={1} max={50} value={c.count}
          onChange={(e) => onChange({ count: Math.min(50, Math.max(1, Math.trunc(Number(e.target.value) || 1))) })}
          className="h-8 w-24"
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted-foreground">显示级别</span>
        <div className="flex flex-wrap gap-1.5">
          {ALL_LOG_LEVELS.map((lv) => {
            const on = c.levels.includes(lv);
            return (
              <button
                key={lv}
                type="button"
                onClick={() => {
                  const next = on ? c.levels.filter((x) => x !== lv) : [...c.levels, lv];
                  if (next.length > 0) onChange({ levels: next });
                }}
                className={cn(
                  'rounded-md border px-2.5 py-1 text-xs uppercase transition-colors cursor-pointer',
                  on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/40',
                )}
              >
                {lv}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

export function SessionsConfigForm({ config, onChange }: FormProps) {
  const c = parseSessionsConfig(config);
  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5">
        <span className="text-sm text-muted-foreground">排序</span>
        <div className="flex flex-wrap gap-1.5">
          {(['recent', 'uin', 'nickname'] as SortOpt[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ sort: s })}
              className={cn(
                'rounded-md border px-2.5 py-1 text-xs transition-colors cursor-pointer',
                c.sort === s ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/40',
              )}
            >
              {SORT_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1.5 text-sm">
        <span className="text-muted-foreground">筛选（昵称 / QQ 号）</span>
        <Input value={c.filter} placeholder="留空显示全部" maxLength={100} onChange={(e) => onChange({ filter: e.target.value })} className="h-8" />
      </label>
    </div>
  );
}
