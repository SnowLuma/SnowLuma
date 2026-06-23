import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
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
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>触发词</Label>
                  <Input
                    className="w-full font-mono tabular-nums"
                    value={sc.trigger}
                    disabled={disabled}
                    maxLength={32}
                    onChange={(e) => setStatusCommand({ trigger: e.target.value })}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                触发词：默认 #sl，最长 32 字符。匹配前会去除首尾空格并转为小写。
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-28 flex-col gap-1.5">
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
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                冷却时间：同一会话在该秒数内重复触发词不再回复，防刷屏。0 表示不限制。
              </TooltipContent>
            </Tooltip>
          </div>

          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                不转发下游：开启后命中的 <code className="font-mono">#sl</code> 不再投递给已连接的 Bot（仍会回复并本地记录）。默认关闭即透传。
              </TooltipContent>
            </Tooltip>
          </div>

          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
            <li>收到纯文本匹配触发词时回复 SnowLuma 版本 / 平台 / 运行时长。</li>
            <li>任何人可触发，关闭后完全不响应。</li>
          </ul>
        </div>
      </details>

      <NotificationOptIn
        selectedIds={config.notifications?.channelIds ?? []}
        onChange={(channelIds) => onChange({ ...config, notifications: { channelIds } })}
      />
    </div>
  );
}
