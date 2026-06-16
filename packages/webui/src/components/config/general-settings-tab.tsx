// "通用设置" tab — fields that apply to the whole OneBotInstance rather
// than any specific adapter: the music-sign service URL and the built-in
// `#sl` status command. Edits here mark the config dirty and are
// auto-saved with debounce by the parent ConfigPage.

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { NotificationOptIn } from '@/components/config/notification-opt-in';
import type { OneBotConfig, StatusCommandConfig } from '@/types';

interface GeneralSettingsTabProps {
  config: OneBotConfig;
  onChange: (next: OneBotConfig) => void;
}

export function GeneralSettingsTab({ config, onChange }: GeneralSettingsTabProps) {
  const sc = config.statusCommand;
  const setStatusCommand = (patch: Partial<StatusCommandConfig>) =>
    onChange({ ...config, statusCommand: { ...sc, ...patch } });

  return (
    <div className="flex flex-col gap-4">
      <div className="flex flex-col gap-1.5 rounded-lg border bg-card/40 p-4">
        <Label>音乐签名服务 URL</Label>
        <Input
          type="url"
          placeholder="留空则不启用"
          value={config.musicSignUrl ?? ''}
          onChange={(e) => onChange({ ...config, musicSignUrl: e.target.value || undefined })}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          用于音乐分享卡片签名。未配置时音乐相关消息段会回落为普通文本。
        </p>
      </div>

      <div className="flex flex-col gap-4 rounded-lg border bg-card/40 p-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <Label>
              内置状态命令 <code className="font-mono text-xs">#sl</code>
            </Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              收到纯文本 <code className="font-mono">#sl</code> 时回复 SnowLuma 版本 / 平台 / 运行时长。任何人可触发，关闭后完全不响应。
            </p>
          </div>
          <ToggleSwitch
            value={sc.enabled}
            onChange={(v) => setStatusCommand({ enabled: v })}
            ariaLabel="启用 #sl 状态命令"
          />
        </div>

        <div className="flex items-start justify-between gap-3 border-t pt-3">
          <div className="min-w-0">
            <Label className={sc.enabled ? undefined : 'text-muted-foreground'}>不转发给下游（swallow）</Label>
            <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
              开启后，命中的 <code className="font-mono">#sl</code> 不再投递给已连接的 Bot（仍会回复并本地记录）。默认关闭即透传。
            </p>
          </div>
          <ToggleSwitch
            value={sc.swallow}
            onChange={(v) => setStatusCommand({ swallow: v })}
            ariaLabel="吞掉 #sl 不转发给下游"
            disabled={!sc.enabled}
          />
        </div>

        <div className="flex flex-col gap-1.5 border-t pt-3">
          <Label className={sc.enabled ? undefined : 'text-muted-foreground'}>回复冷却（秒）</Label>
          <Input
            type="number"
            min={0}
            className="w-32 tabular-nums"
            value={sc.cooldownSeconds}
            disabled={!sc.enabled}
            onChange={(e) => {
              const n = Math.trunc(Number(e.target.value));
              setStatusCommand({ cooldownSeconds: Number.isFinite(n) && n >= 0 ? n : 0 });
            }}
          />
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            同一会话在该秒数内重复 <code className="font-mono">#sl</code> 不再回复，防刷屏。<code className="font-mono">0</code> 表示不限制。
          </p>
        </div>
      </div>

      <NotificationOptIn
        selectedIds={config.notifications?.channelIds ?? []}
        onChange={(channelIds) => onChange({ ...config, notifications: { channelIds } })}
      />
    </div>
  );
}
