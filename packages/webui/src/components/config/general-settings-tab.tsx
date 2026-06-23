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
        <Label>闊充箰绛惧悕鏈嶅姟 URL</Label>
        <Input
          type="url"
          placeholder="鐣欑┖鍒欎笉鍚敤"
          value={config.musicSignUrl ?? ''}
          onChange={(e) => onChange({ ...config, musicSignUrl: e.target.value || undefined })}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          鐢ㄤ簬闊充箰鍒嗕韩鍗＄墖绛惧悕銆傛湭閰嶇疆鏃堕煶涔愮浉鍏虫秷鎭浼氬洖钀戒负鏅€氭枃鏈€?        </p>
      </div>

      <details className="group rounded-lg border bg-card/40 p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground transition-transform group-open:rotate-90">鈻?/span>
            <Label>鍐呯疆鐘舵€佸懡浠?<code className="font-mono text-xs">#sl</code></Label>
          </div>
          <ToggleSwitch
            value={sc.enabled}
            onChange={(v) => setStatusCommand({ enabled: v })}
            ariaLabel="鍚敤鐘舵€佸懡浠?
          />
        </summary>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>瑙﹀彂璇?/Label>
                  <Input
                    className="w-full font-mono tabular-nums"
                    value={sc.trigger}
                    disabled={disabled}
                    onChange={(e) => setStatusCommand({ trigger: e.target.value.slice(0, 64) })}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                瑙﹀彂璇嶏細榛樿 #sl锛屾渶闀?64 瀛楃銆傚尮閰嶅墠浼氬幓闄ら灏剧┖鏍煎苟杞负灏忓啓銆?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>鍖归厤</Label>
                  <Select
                    className="w-full"
                    value={sc.matchMode}
                    disabled={disabled}
                    onChange={(e) => setStatusCommand({ matchMode: e.target.value as StatusCommandConfig['matchMode'] })}
                  >
                    <option value="exact">绮剧‘</option>
                    <option value="prefix">鍓嶇紑</option>
                    <option value="contains">鍖呭惈</option>
                    <option value="regex">姝ｅ垯</option>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                鍖归厤妯″紡锛氱簿纭?闇€涓庤Е鍙戣瘝瀹屽叏涓€鑷达紱鍓嶇紑=娑堟伅浠ユ寮€澶达紱鍖呭惈=娑堟伅鍚湁姝よ瘝锛涙鍒?鎸夋鍒欒〃杈惧紡鍖归厤銆備粎绾枃鏈秷鎭彲鍖归厤锛屽惈濯掍綋娈电殑涓嶅尮閰嶃€?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-28 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>鑼冨洿</Label>
                  <Select
                    className="w-full"
                    value={sc.scope}
                    disabled={disabled}
                    onChange={(e) => setStatusCommand({ scope: e.target.value as StatusCommandConfig['scope'] })}
                  >
                    <option value="all">鍏ㄩ儴</option>
                    <option value="private">浠呯鑱?/option>
                    <option value="group">浠呯兢鑱?/option>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                鍝嶅簲鑼冨洿锛氬叏閮?鎵€鏈変細璇濆潎鍝嶅簲锛涗粎绉佽亰=浠呭鐞嗙鑱婃秷鎭紱浠呯兢鑱?浠呭鐞嗙兢鑱婃秷鎭€?              </TooltipContent>
            </Tooltip>
          </div>

          {/* Row 2 鈥?Toggle 鐙崰涓€琛?*/}
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-24 flex-col gap-1.5">
                  <Label className="flex items-center gap-1.5">
                    灞曠ず
                    <ToggleSwitch
                      value={sc.showPlatform}
                      onChange={(v) => setStatusCommand({ showPlatform: v })}
                      ariaLabel="灞曠ず骞冲彴淇℃伅"
                      disabled={disabled}
                    />
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                灞曠ず骞冲彴淇℃伅锛氬洖澶嶄腑鍖呭惈绯荤粺骞冲彴鏍囪瘑琛屻€傚叧闂悗璇ヨ涓嶅嚭鐜帮紝鍏朵綑鐘舵€佷俊鎭収甯稿洖澶嶃€?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-24 flex-col gap-1.5">
                  <Label className="flex items-center gap-1.5">
                    涓嶈浆鍙?                    <ToggleSwitch
                      value={sc.swallow}
                      onChange={(v) => setStatusCommand({ swallow: v })}
                      ariaLabel="涓嶈浆鍙戠粰涓嬫父"
                      disabled={disabled}
                    />
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                涓嶈浆鍙戜笅娓革細寮€鍚悗鍛戒腑鐨?<code className="font-mono">#sl</code> 涓嶅啀鎶曢€掔粰宸茶繛鎺ョ殑 Bot锛堜粛浼氬洖澶嶅苟鏈湴璁板綍锛夈€傞粯璁ゅ叧闂嵆閫忎紶銆?              </TooltipContent>
            </Tooltip>
          </div>

          {/* Row 3 鈥?Select / Input 鐙崰涓€琛?*/}
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
                  <Label className={disabled || !sc.showPlatform ? 'text-muted-foreground' : undefined}>璇︾粏搴?/Label>
                  <Select
                    className="w-full"
                    value={sc.platformDetail}
                    disabled={disabled || !sc.showPlatform}
                    onChange={(e) => setStatusCommand({ platformDetail: e.target.value as StatusCommandConfig['platformDetail'] })}
                  >
                    <option value="brief">绠€瑕?/option>
                    <option value="summary">鎽樿</option>
                    <option value="detailed">璇︾粏</option>
                    <option value="fuzzy">妯＄硦</option>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                骞冲彴璇︾粏搴︼細绠€瑕?浠呯郴缁熷悕绉帮紱鎽樿=绯荤粺鍚嶇О+鐗堟湰鍙凤紱璇︾粏=瀹屾暣绯荤粺淇℃伅锛涙ā绯?璇箟妯＄硦鍖栧鐞嗗悗鍥炲銆?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>鍐峰嵈</Label>
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
                鍐峰嵈鏃堕棿锛氬悓涓€浼氳瘽鍦ㄨ绉掓暟鍐呴噸澶嶈Е鍙戣瘝涓嶅啀鍥炲锛岄槻鍒峰睆銆? 琛ㄧず涓嶉檺鍒躲€?              </TooltipContent>
            </Tooltip>
          </div>

          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
            <li>鏀跺埌绾枃鏈尮閰嶈Е鍙戣瘝鏃跺洖澶?SnowLuma 鐗堟湰 / 骞冲彴 / 杩愯鏃堕暱銆?/li>
            <li>浠讳綍浜哄彲瑙﹀彂锛屽叧闂悗瀹屽叏涓嶅搷搴斻€?/li>
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
