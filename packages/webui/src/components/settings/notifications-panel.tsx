// Settings → 通知 tab. Mirrors the node-config UX: the first screen is
// info-only cards (name / url / template + an inline enable toggle); creating
// and editing always go through a dialog. All changes auto-save (debounced),
// like the per-account config page — no explicit save button.
import { useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { Bell, Loader2, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { useApi } from '@/lib/api';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import type { NotificationChannel, NotificationsConfig } from '@/types';
import { NotificationChannelDialog } from './notification-channel-dialog';

const DEFAULT_TEMPLATE = `{
  "title": "账号状态通知：{event}",
  "desp": "您的账号状态发生了改变。\\n\\n**昵称**：{nickname}\\n**QQ号**：{uin}\\n**当前状态**：{event}\\n**时间**：{time}"
}`;

/** A fresh channel with a non-colliding default id. */
function blankChannel(existing: NotificationChannel[]): NotificationChannel {
  const used = new Set(existing.map((c) => c.id));
  let n = existing.length + 1;
  while (used.has(`channel-${n}`)) n += 1;
  return { id: `channel-${n}`, name: '', url: '', bodyTemplate: DEFAULT_TEMPLATE, enabled: true };
}

interface DialogState {
  open: boolean;
  index: number | null; // null → create
  seed: NotificationChannel;
}

export function NotificationsPanel() {
  const api = useApi();
  const [config, setConfig] = useState<NotificationsConfig | null>(null);
  const [loading, setLoading] = useState(true);
  const [dialog, setDialog] = useState<DialogState>({ open: false, index: null, seed: blankChannel([]) });
  const [testing, setTesting] = useState<string | null>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const saveTimer = useRef<number | null>(null);
  const msgTimer = useRef<number | null>(null);
  const saveGen = useRef(0);

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const cfg = await api.notifications.getConfig();
        if (!cancelled) setConfig(cfg);
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

  useEffect(
    () => () => {
      if (saveTimer.current) clearTimeout(saveTimer.current);
      if (msgTimer.current) clearTimeout(msgTimer.current);
    },
    [],
  );

  const flash = (kind: 'ok' | 'err', text: string) => {
    setMsg({ kind, text });
    if (msgTimer.current) clearTimeout(msgTimer.current);
    msgTimer.current = window.setTimeout(() => setMsg(null), 2400);
  };

  /** Apply locally + debounced auto-save. A generation guard reconciles with
   *  the server's normalized result only if no newer edit landed meanwhile. */
  const commit = (next: NotificationsConfig) => {
    setConfig(next);
    const gen = ++saveGen.current;
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = window.setTimeout(() => {
      void api.notifications
        .saveConfig(next)
        .then((result) => {
          // Only the latest save reconciles + confirms; a superseded in-flight
          // save stays silent (its successor will confirm).
          if (saveGen.current !== gen) return;
          setConfig(result);
          flash('ok', '已保存');
        })
        .catch(() => flash('err', '保存失败，请检查服务器日志'));
    }, 350);
  };

  if (loading || !config) {
    return (
      <div className="flex items-center gap-2 rounded-lg border bg-card/40 p-6 text-sm text-muted-foreground">
        <Loader2 className="size-4 animate-spin" /> 加载中…
      </div>
    );
  }

  const channels = config.channels;
  const setChannels = (next: NotificationChannel[]) => commit({ ...config, channels: next });
  const otherIds = (index: number | null) => channels.filter((_, i) => i !== index).map((c) => c.id);

  const openCreate = () => setDialog({ open: true, index: null, seed: blankChannel(channels) });
  const openEdit = (i: number) => setDialog({ open: true, index: i, seed: channels[i] });
  const submitChannel = (ch: NotificationChannel) => {
    if (dialog.index == null) setChannels([...channels, ch]);
    else setChannels(channels.map((c, idx) => (idx === dialog.index ? ch : c)));
  };

  const test = async (id: string) => {
    setTesting(id);
    // Persist any pending edit first — the server tests the stored channel by id.
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      saveTimer.current = null;
    }
    try {
      await api.notifications.saveConfig(config);
      const res = await api.notifications.test(id);
      flash(res.success ? 'ok' : 'err', res.message ?? (res.success ? '测试发送成功' : '测试发送失败'));
    } catch {
      flash('err', '测试请求失败');
    } finally {
      setTesting(null);
    }
  };

  return (
    <div className="flex flex-col gap-4">
      {/* Global settings */}
      <div className="flex flex-col gap-4 rounded-xl border bg-card/40 p-4">
        <div className="flex items-start gap-2 text-[11px] leading-relaxed text-muted-foreground">
          <Bell className="mt-0.5 size-3.5 shrink-0" />
          <p>
            账号上线 / 下线时向启用的渠道 POST 一条通知（机械转发，仅去抖防刷屏）。渠道在此全局定义，每个账号在其「配置」页勾选启用哪些。
          </p>
        </div>
        <div className="flex flex-col gap-1.5 border-t pt-3">
          <Label>去抖窗口（秒）</Label>
          <Input
            type="number"
            min={0}
            max={3600}
            className="w-32 tabular-nums"
            value={config.debounceSeconds}
            onChange={(e) => {
              const n = Math.trunc(Number(e.target.value));
              commit({ ...config, debounceSeconds: Number.isFinite(n) ? Math.min(3600, Math.max(0, n)) : 0 });
            }}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            下线后在该秒数内自愈则不发；超时才发「下线」，恢复时再发「上线」。<code className="font-mono">0</code> = 立即发、不去抖。
          </p>
        </div>
      </div>

      {/* Channels */}
      <div className="flex flex-col gap-2">
        <div className="flex items-center justify-between">
          <h3 className="text-sm font-semibold tracking-tight">通知渠道</h3>
          {channels.length > 0 && (
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus className="size-3.5" /> 新增渠道
            </Button>
          )}
        </div>

        {channels.length === 0 ? (
          <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-muted-foreground">
            <Bell className="size-8 opacity-40" strokeWidth={1.5} />
            <p className="text-sm">还没有通知渠道</p>
            <Button variant="outline" size="sm" onClick={openCreate}>
              <Plus className="size-3.5" /> 创建第一个
            </Button>
          </div>
        ) : (
          <div className="flex flex-col gap-2">
            {channels.map((ch, i) => (
              <ChannelCard
                key={ch.id}
                channel={ch}
                testing={testing === ch.id}
                onToggle={(v) => setChannels(channels.map((c, idx) => (idx === i ? { ...c, enabled: v } : c)))}
                onTest={() => void test(ch.id)}
                onEdit={() => openEdit(i)}
                onDelete={() => setChannels(channels.filter((_, idx) => idx !== i))}
              />
            ))}
          </div>
        )}
      </div>

      {msg && <p className={cn('text-xs', msg.kind === 'ok' ? 'text-success' : 'text-destructive')}>{msg.text}</p>}

      {dialog.open && (
        <NotificationChannelDialog
          open={dialog.open}
          onOpenChange={(open) => !open && setDialog((d) => ({ ...d, open: false }))}
          isEdit={dialog.index != null}
          initial={dialog.seed}
          otherIds={otherIds(dialog.index)}
          onSubmit={submitChannel}
        />
      )}
    </div>
  );
}

interface ChannelCardProps {
  channel: NotificationChannel;
  testing: boolean;
  onToggle: (v: boolean) => void;
  onTest: () => void;
  onEdit: () => void;
  onDelete: () => void;
}

/** Info-only row + inline actions. No live-typed fields — editing is the dialog. */
function ChannelCard({ channel, testing, onToggle, onTest, onEdit, onDelete }: ChannelCardProps) {
  const off = useTheme().appearance.disableMotion;
  return (
    <motion.div
      initial={off ? false : { opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={off ? { duration: 0 } : { duration: 0.18 }}
      className={cn(
        'flex flex-col gap-2 rounded-xl border bg-card/40 p-3.5 transition-all hover:bg-accent/20 sm:flex-row sm:items-center sm:gap-3',
        !channel.enabled && 'opacity-60',
      )}
    >
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span className="font-medium">{channel.name || channel.id}</span>
          <Badge variant="secondary" className="font-mono font-normal">{channel.id}</Badge>
          {!channel.enabled && <Badge variant="secondary" className="font-normal">已停用</Badge>}
        </div>
        <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">{channel.url}</div>
        <div className="mt-1 truncate font-mono text-[11px] text-muted-foreground/80">{channel.bodyTemplate}</div>
      </div>

      <div className="flex items-center gap-1.5 sm:justify-end">
        <ToggleSwitch value={channel.enabled} onChange={onToggle} ariaLabel={`启用 ${channel.name || channel.id}`} />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onTest}
          disabled={testing}
          aria-label="测试发送"
          className="text-muted-foreground hover:text-foreground"
        >
          {testing ? <Loader2 className="size-4 animate-spin" /> : <Send className="size-4" />}
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onEdit}
          aria-label="编辑"
          className="text-muted-foreground hover:text-foreground"
        >
          <Pencil className="size-4" />
        </Button>
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onDelete}
          aria-label="删除"
          className="text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
    </motion.div>
  );
}
