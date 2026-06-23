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
        <Label>闂婂厖绠扮粵鎯ф倳閺堝秴濮?URL</Label>
        <Input
          type="url"
          placeholder="閻ｆ瑧鈹栭崚娆庣瑝閸氼垳鏁?
          value={config.musicSignUrl ?? ''}
          onChange={(e) => onChange({ ...config, musicSignUrl: e.target.value || undefined })}
        />
        <p className="text-[11px] leading-relaxed text-muted-foreground">
          閻劋绨棅鍏呯閸掑棔闊╅崡锛勫缁涙儳鎮曢妴鍌涙弓闁板秶鐤嗛弮鍫曠叾娑旀劗娴夐崗铏Х閹垱顔屾导姘礀閽€鎴掕礋閺咁噣鈧碍鏋冮張顑锯偓?        </p>
      </div>

      <details className="group rounded-lg border bg-card/40 p-4">
        <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            <span className="text-muted-foreground transition-transform group-open:rotate-90">閳?/span>
            <Label>閸愬懐鐤嗛悩鑸碘偓浣告嚒娴?<code className="font-mono text-xs">#sl</code></Label>
          </div>
          <ToggleSwitch
            value={sc.enabled}
            onChange={(v) => setStatusCommand({ enabled: v })}
            ariaLabel="閸氼垳鏁ら悩鑸碘偓浣告嚒娴?
          />
        </summary>

        <div className="mt-4 flex flex-col gap-3">
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>鐟欙箑褰傜拠?/Label>
                  <Input
                    className="w-full font-mono tabular-nums"
                    value={sc.trigger}
                    disabled={disabled}
                    onChange={(e) => setStatusCommand({ trigger: e.target.value.slice(0, 64) })}
                  />
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                鐟欙箑褰傜拠宥忕窗姒涙顓?#sl閿涘本娓堕梹?64 鐎涙顑侀妴鍌氬爱闁板秴澧犳导姘箵闂勩倝顩荤亸鍓р敄閺嶇厧鑻熸潪顑胯礋鐏忓繐鍟撻妴?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-32 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>閸栧綊鍘?/Label>
                  <Select
                    className="w-full"
                    value={sc.matchMode}
                    disabled={disabled}
                    onChange={(e) => setStatusCommand({ matchMode: e.target.value as StatusCommandConfig['matchMode'] })}
                  >
                    <option value="exact">缁墽鈥?/option>
                    <option value="prefix">閸撳秶绱?/option>
                    <option value="contains">閸栧懎鎯?/option>
                    <option value="regex">濮濓絽鍨?/option>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                閸栧綊鍘ゅΟ鈥崇础閿涙氨绨跨涵?闂団偓娑撳氦袝閸欐垼鐦濈€瑰苯鍙忔稉鈧懛杈剧幢閸撳秶绱?濞戝牊浼呮禒銉︻劃瀵偓婢惰揪绱遍崠鍛儓=濞戝牊浼呴崥顐ｆ箒濮濄倛鐦濋敍娑欘劀閸?閹稿顒滈崚娆掋€冩潏鎯х础閸栧綊鍘ら妴鍌欑矌缁绢垱鏋冮張顒佺Х閹垰褰查崠褰掑帳閿涘苯鎯堟刊鎺嶇秼濞堢數娈戞稉宥呭爱闁板秲鈧?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-28 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>閼煎啫娲?/Label>
                  <Select
                    className="w-full"
                    value={sc.scope}
                    disabled={disabled}
                    onChange={(e) => setStatusCommand({ scope: e.target.value as StatusCommandConfig['scope'] })}
                  >
                    <option value="all">閸忋劑鍎?/option>
                    <option value="private">娴犲懐顫嗛懕?/option>
                    <option value="group">娴犲懐鍏㈤懕?/option>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                閸濆秴绨查懠鍐ㄦ纯閿涙艾鍙忛柈?閹碘偓閺堝绱扮拠婵嗘綆閸濆秴绨查敍娑楃矌缁変浇浜?娴犲懎顦╅悶鍡欘潌閼卞﹥绉烽幁顖ょ幢娴犲懐鍏㈤懕?娴犲懎顦╅悶鍡欏參閼卞﹥绉烽幁顖樷偓?              </TooltipContent>
            </Tooltip>
          </div>

          {/* Row 2 閳?Toggle 閻欘剙宕版稉鈧悰?*/}
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-24 flex-col gap-1.5">
                  <Label className="flex items-center gap-1.5">
                    鐏炴洜銇?                    <ToggleSwitch
                      value={sc.showPlatform}
                      onChange={(v) => setStatusCommand({ showPlatform: v })}
                      ariaLabel="鐏炴洜銇氶獮鍐插酱娣団剝浼?
                      disabled={disabled}
                    />
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                鐏炴洜銇氶獮鍐插酱娣団剝浼呴敍姘礀婢跺秳鑵戦崠鍛儓缁崵绮洪獮鍐插酱閺嶅洩鐦戠悰灞烩偓鍌氬彠闂傤厼鎮楃拠銉攽娑撳秴鍤悳甯礉閸忔湹缍戦悩鑸碘偓浣蜂繆閹垳鍙庣敮绋挎礀婢跺秲鈧?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-24 flex-col gap-1.5">
                  <Label className="flex items-center gap-1.5">
                    娑撳秷娴嗛崣?                    <ToggleSwitch
                      value={sc.swallow}
                      onChange={(v) => setStatusCommand({ swallow: v })}
                      ariaLabel="娑撳秷娴嗛崣鎴犵舶娑撳鐖?
                      disabled={disabled}
                    />
                  </Label>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                娑撳秷娴嗛崣鎴滅瑓濞撻潻绱板鈧崥顖氭倵閸涙垝鑵戦惃?<code className="font-mono">#sl</code> 娑撳秴鍟€閹舵洟鈧帞绮板鑼剁箾閹恒儳娈?Bot閿涘牅绮涙导姘礀婢跺秴鑻熼張顒€婀寸拋鏉跨秿閿涘鈧倿绮拋銈呭彠闂傤厼宓嗛柅蹇庣炊閵?              </TooltipContent>
            </Tooltip>
          </div>

          {/* Row 3 閳?Select / Input 閻欘剙宕版稉鈧悰?*/}
          <div className="flex flex-row flex-wrap gap-3">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
                  <Label className={disabled || !sc.showPlatform ? 'text-muted-foreground' : undefined}>鐠囷妇绮忔惔?/Label>
                  <Select
                    className="w-full"
                    value={sc.platformDetail}
                    disabled={disabled || !sc.showPlatform}
                    onChange={(e) => setStatusCommand({ platformDetail: e.target.value as StatusCommandConfig['platformDetail'] })}
                  >
                    <option value="brief">缁犫偓鐟?/option>
                    <option value="summary">閹芥顩?/option>
                    <option value="detailed">鐠囷妇绮?/option>
                    <option value="fuzzy">濡紕纭?/option>
                  </Select>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" sideOffset={6}>
                楠炲啿褰寸拠锔剧矎鎼达讣绱扮粻鈧憰?娴犲懐閮寸紒鐔锋倳缁夊府绱遍幗妯款洣=缁崵绮洪崥宥囆?閻楀牊婀伴崣鍑ょ幢鐠囷妇绮?鐎瑰本鏆ｇ化鑽ょ埠娣団剝浼呴敍娑櫮佺化?鐠囶厺绠熷Ο锛勭ˇ閸栨牕顦╅悶鍡楁倵閸ョ偛顦查妴?              </TooltipContent>
            </Tooltip>
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex min-w-0 flex-1 basis-36 flex-col gap-1.5">
                  <Label className={disabled ? 'text-muted-foreground' : undefined}>閸愬嘲宓?/Label>
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
                閸愬嘲宓堥弮鍫曟？閿涙艾鎮撴稉鈧导姘崇樈閸︺劏顕氱粔鎺撴殶閸愬懘鍣告径宥埿曢崣鎴ｇ槤娑撳秴鍟€閸ョ偛顦查敍宀勬Щ閸掑嘲鐫嗛妴? 鐞涖劎銇氭稉宥夋閸掕翰鈧?              </TooltipContent>
            </Tooltip>
          </div>

          <ul className="list-disc space-y-1 pl-4 text-[11px] leading-relaxed text-muted-foreground">
            <li>閺€璺哄煂缁绢垱鏋冮張顒€灏柊宥埿曢崣鎴ｇ槤閺冭泛娲栨径?SnowLuma 閻楀牊婀?/ 楠炲啿褰?/ 鏉╂劘顢戦弮鍫曟毐閵?/li>
            <li>娴犺缍嶆禍鍝勫讲鐟欙箑褰傞敍灞藉彠闂傤厼鎮楃€瑰苯鍙忔稉宥呮惙鎼存柣鈧?/li>
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
