import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
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
                    maxLength={64}
                    onChange={(e) => setStatusCommand({ trigger: e.target.value.slice(0, 64) })}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                触发词：默认 #sl，最长 64 字符。匹配前会去除首尾空格并转为小写。
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                匹配模式：精确=需与触发词完全一致；前缀=消息以此开头；包含=消息含有此词；正则=按正则表达式匹配。仅纯文本消息可匹配，含媒体段的不匹配。
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                响应范围：全部=所有会话均响应；仅私聊=仅处理私聊消息；仅群聊=仅处理群聊消息。
              </TooltipContent>
            </Tooltip>
          </div>

          {/* Row 2 — Toggle 独占一行 */}
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                展示平台信息：回复中包含系统平台标识行。关闭后该行不出现，其余状态信息照常回复。
              </TooltipContent>
            </Tooltip>
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

          {/* Row 3 — Select / Input 独占一行 */}
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                平台详细度：简要=仅系统名称；摘要=系统名称+版本号；详细=完整系统信息；模糊=语义模糊化处理后回复。
              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
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
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                冷却时间：同一会话在该秒数内重复触发词不再回复，防刷屏。0 表示不限制。
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
