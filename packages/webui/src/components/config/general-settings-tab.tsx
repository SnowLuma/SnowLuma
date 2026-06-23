import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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

  const disabled = !sc.enabled;

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

      <details className="group rounded-lg border bg-card/40 p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground transition-transform group-open:rotate-90">▶</span>
            <Label>内置状态命令 <code className="font-mono text-xs">#sl</code></Label>
          </div>
          <ToggleSwitch
            value={sc.enabled}
            onChange={(v) => setStatusCommand({ enabled: v })}
            ariaLabel="启用状态命令"
          />
        </summary>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-row flex-wrap gap-3">
            <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
              <Label className={disabled ? 'text-muted-foreground' : undefined}>触发词</Label>
              <Input
                className="w-full font-mono tabular-nums"
                value={sc.trigger}
                disabled={disabled}
                onChange={(e) => setStatusCommand({ trigger: e.target.value.slice(0, 64) })}
              />
            </div>
            <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1.5">
              <Label className={disabled ? 'text-muted-foreground' : undefined}>匹配</Label>
              <Select
                className="w-full"
                value={sc.matchMode}
                disabled={disabled}
                onChange={(e) => setStatusCommand({ matchMode: e.target.value as StatusCommandConfig['matchMode'] })}
              >
                <option value="exact">精确</option>
                <option value="prefix">前缀</option>
                <option value="contains">包含</option>
                <option value="regex">正则</option>
              </Select>
            </div>
            <div className="flex min-w-0 flex-1 basis-28 flex-col gap-1.5">
              <Label className={disabled ? 'text-muted-foreground' : undefined}>范围</Label>
              <Select
                className="w-full"
                value={sc.scope}
                disabled={disabled}
                onChange={(e) => setStatusCommand({ scope: e.target.value as StatusCommandConfig['scope'] })}
              >
                <option value="all">全部</option>
                <option value="private">仅私聊</option>
                <option value="group">仅群聊</option>
              </Select>
            </div>
          </div>

          <div className="flex flex-row flex-wrap items-start gap-3">
            <div className="flex min-w-0 flex-1 basis-24 flex-col gap-1.5">
              <Label className="flex items-center gap-1.5">
                展示
                <ToggleSwitch
                  value={sc.showPlatform}
                  onChange={(v) => setStatusCommand({ showPlatform: v })}
                  ariaLabel="展示平台信息"
                  disabled={disabled}
                />
              </Label>
            </div>
            <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
              <Label className={disabled || !sc.showPlatform ? 'text-muted-foreground' : undefined}>详细度</Label>
              <Select
                className="w-full"
                value={sc.platformDetail}
                disabled={disabled || !sc.showPlatform}
                onChange={(e) => setStatusCommand({ platformDetail: e.target.value as StatusCommandConfig['platformDetail'] })}
              >
                <option value="brief">简要</option>
                <option value="summary">摘要</option>
                <option value="detailed">详细</option>
                <option value="fuzzy">模糊</option>
              </Select>
            </div>
            <div className="flex min-w-0 flex-1 basis-24 flex-col gap-1.5">
              <Label className="flex items-center gap-1.5">
                不转发
                <ToggleSwitch
                  value={sc.swallow}
                  onChange={(v) => setStatusCommand({ swallow: v })}
                  ariaLabel="不转发给下游"
                  disabled={disabled}
                />
              </Label>
            </div>
            <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
              <Label className={disabled ? 'text-muted-foreground' : undefined}>冷却</Label>
              <Input
                type="number"
                min={0}
                className="w-full tabular-nums"
                value={sc.cooldownSeconds}
                disabled={disabled}
                onChange={(e) => {
                  const n = Math.trunc(Number(e.target.value));
                  setStatusCommand({ cooldownSeconds: Number.isFinite(n) && n >= 0 ? n : 0 });
                }}
              />
            </div>
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            收到纯文本 <code className="font-mono">#sl</code> 时回复版本 / 平台 / 运行时长。
            关闭「展示平台」后「平台:」一行不出现。
            匹配前去除首尾空格并转小写。
            冷却 <code className="font-mono">0</code> = 不限制。
          </p>
        </div>
      </details>

      <NotificationOptIn
        selectedIds={config.notifications?.channelIds ?? []}
        onChange={(channelIds) => onChange({ ...config, notifications: { channelIds } })}
      />
    </div>
  );
}
