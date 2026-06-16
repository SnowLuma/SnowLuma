// Settings → 通知 tab. Global webhook-channel store (CRUD + per-channel test
// send) and the global debounce window. Channels are global; each account opts
// in from its own Config page. The server total-normalizes on save (a channel
// with an invalid slug id or a non-http(s) URL is dropped), so after 保存 the
// list reflects exactly what was accepted.
import { useEffect, useMemo, useState } from 'react';
import { Bell, Loader2, Plus, Send, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { useApi } from '@/lib/api';
import { cn } from '@/lib/utils';
import type { NotificationChannel, NotificationsConfig } from '@/types';

const DEFAULT_TEMPLATE = '{nickname}({uin}) {event} @ {time}';

function blankChannel(n: number): NotificationChannel {
  return { id: `channel-${n}`, name: '', url: '', bodyTemplate: DEFAULT_TEMPLATE, enabled: true };
}

export function NotificationsPanel() {
  const api = useApi();
  const [config, setConfig] = useState<NotificationsConfig | null>(null);
  const [saved, setSaved] = useState('');
  const [loading, setLoading] = useState(true);
  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.notifications.getConfig();
        if (cancelled) return;
        setConfig(cfg);
        setSaved(JSON.stringify(cfg));
      } catch {
        if (!cancelled) setMsg({ kind: 'err', text: '加载通知配置失败' });
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [api]);

  const dirty = useMemo(() => (config ? JSON.stringify(config) !== saved : false), [config, saved]);

  if (loading || !config) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-card/40 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 加载中…
      </div>
    );
  }

  const patch = (p: Partial<NotificationsConfig>) => setConfig({ ...config, ...p });
  const patchChannel = (i: number, p: Partial<NotificationChannel>) =>
    setConfig({ ...config, channels: config.channels.map((c, idx) => (idx === i ? { ...c, ...p } : c)) });
  const addChannel = () => {
    // Avoid a default id colliding with an existing one (e.g. after deletes),
    // which the server would dedup-drop on save.
    const used = new Set(config.channels.map((c) => c.id));
    let n = config.channels.length + 1;
    while (used.has(`channel-${n}`)) n += 1;
    setConfig({ ...config, channels: [...config.channels, blankChannel(n)] });
  };
  const removeChannel = (i: number) =>
    setConfig({ ...config, channels: config.channels.filter((_, idx) => idx !== i) });

  const save = async () => {
    setSaving(true);
    setMsg(null);
    try {
      const result = await api.notifications.saveConfig(config);
      setConfig(result);
      setSaved(JSON.stringify(result));
      const dropped = config.channels.length - result.channels.length;
      setMsg({
        kind: 'ok',
        text: dropped > 0 ? `已保存（${dropped} 个无效渠道被丢弃，需有效 slug id + http(s) URL）` : '已保存',
      });
    } catch {
      setMsg({ kind: 'err', text: '保存失败，请检查服务器日志' });
    } finally {
      setSaving(false);
    }
  };

  const test = async (id: string) => {
    setTesting(id);
    setMsg(null);
    try {
      const res = await api.notifications.test(id);
      setMsg({ kind: res.success ? 'ok' : 'err', text: res.message ?? (res.success ? '测试发送成功' : '测试发送失败') });
    } catch {
      setMsg({ kind: 'err', text: '测试请求失败' });
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      <div className="flex items-start gap-2 rounded-lg border bg-card/40 p-4 text-[11px] leading-relaxed text-muted-foreground">
        <Bell className="mt-0.5 size-3.5 shrink-0" />
        <p>
          账号上线 / 下线时，向启用的渠道 POST 一条渲染后的通知（机械转发，仅去抖防刷屏）。渠道在此全局定义，
          每个账号在其「配置」页勾选启用哪些。模板变量：
          <code className="font-mono">{'{uin}'}</code> <code className="font-mono">{'{nickname}'}</code>{' '}
          <code className="font-mono">{'{event}'}</code>（offline/online） <code className="font-mono">{'{time}'}</code>。
        </p>
      </div>

      {/* Global debounce */}
      <div className="flex flex-col gap-1.5 rounded-lg border bg-card/40 p-4">
        <Label>去抖窗口（秒）</Label>
        <Input
          type="number"
          min={0}
          max={3600}
          className="w-32 tabular-nums"
          value={config.debounceSeconds}
          onChange={(e) => {
            const n = Math.trunc(Number(e.target.value));
            patch({ debounceSeconds: Number.isFinite(n) ? Math.min(3600, Math.max(0, n)) : 0 });
          }}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          下线后在该秒数内自愈则不发（抑制闪断）；超时才发「下线」，恢复时再发「上线」。<code className="font-mono">0</code> 表示不去抖、立即发。
        </p>
      </div>

      {/* Channels */}
      <div className="flex flex-col gap-3">
        {config.channels.length === 0 && (
          <p className="rounded-lg border border-dashed bg-card/20 p-6 text-center text-sm text-muted-foreground">
            还没有渠道。点下方「新增渠道」添加一个 webhook。
          </p>
        )}

        {config.channels.map((ch, i) => (
          <div key={i} className="flex flex-col gap-3 rounded-lg border bg-card/40 p-4">
            <div className="flex items-center justify-between gap-3">
              <div className="flex items-center gap-2">
                <ToggleSwitch
                  value={ch.enabled}
                  onChange={(v) => patchChannel(i, { enabled: v })}
                  ariaLabel={`启用渠道 ${ch.name || ch.id}`}
                />
                <span className={cn('text-sm font-medium', ch.enabled ? undefined : 'text-muted-foreground')}>
                  {ch.name || ch.id || '未命名渠道'}
                </span>
              </div>
              <div className="flex items-center gap-1.5">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  disabled={dirty || testing === ch.id}
                  title={dirty ? '请先保存再测试' : '向该渠道发送一条测试消息'}
                  onClick={() => void test(ch.id)}
                >
                  {testing === ch.id ? <Loader2 className="size-3.5 animate-spin" /> : <Send className="size-3.5" />}
                  测试
                </Button>
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  aria-label="删除渠道"
                  onClick={() => removeChannel(i)}
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            </div>

            <div className="grid gap-3 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">渠道 ID（slug，账号据此勾选）</Label>
                <Input
                  value={ch.id}
                  placeholder="dingtalk"
                  onChange={(e) => patchChannel(i, { id: e.target.value })}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label className="text-xs">显示名</Label>
                <Input
                  value={ch.name}
                  placeholder="钉钉群机器人"
                  onChange={(e) => patchChannel(i, { name: e.target.value })}
                />
              </div>
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Webhook URL（http/https）</Label>
              <Input
                type="url"
                value={ch.url}
                placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
                onChange={(e) => patchChannel(i, { url: e.target.value })}
              />
            </div>

            <div className="flex flex-col gap-1.5">
              <Label className="text-xs">Body 模板</Label>
              <textarea
                value={ch.bodyTemplate}
                rows={3}
                spellCheck={false}
                onChange={(e) => patchChannel(i, { bodyTemplate: e.target.value })}
                className={cn(
                  'w-full rounded-md border border-border bg-transparent px-3 py-2 font-mono text-xs leading-relaxed shadow-xs outline-none transition-[color,box-shadow]',
                  'placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/40',
                )}
              />
            </div>
          </div>
        ))}

        <Button type="button" variant="outline" size="sm" className="self-start" onClick={addChannel}>
          <Plus className="size-3.5" /> 新增渠道
        </Button>
      </div>

      {/* Save bar */}
      <div className="flex items-center gap-3 border-t pt-4">
        <Button type="button" disabled={!dirty || saving} onClick={() => void save()}>
          {saving && <Loader2 className="size-3.5 animate-spin" />} 保存
        </Button>
        {dirty && <span className="text-[11px] text-muted-foreground">有未保存的更改</span>}
        {msg && (
          <span className={cn('text-xs', msg.kind === 'ok' ? 'text-emerald-500' : 'text-destructive')}>{msg.text}</span>
        )}
      </div>
    </div>
  );
}
