// "通用设置" tab — fields that apply to the whole OneBotInstance rather
// than any specific adapter. Currently just the music-sign service URL,
// but the layout has room for additional cross-cutting toggles.

import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import type { OneBotConfig } from '@/types';

interface GeneralSettingsTabProps {
  config: OneBotConfig;
  onChange: (next: OneBotConfig) => void;
}

export function GeneralSettingsTab({ config, onChange }: GeneralSettingsTabProps) {
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
    </div>
  );
}
