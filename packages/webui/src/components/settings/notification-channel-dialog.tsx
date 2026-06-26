// Modal editor for a notification channel — used for both create and edit,
// mirroring NodeEditDialog. Holds a local draft until 保存 (cancel discards).
// The channel id is the stable key per-account opt-ins reference, so it's
// editable only on create and locked on edit.
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { cn } from '@/lib/utils';
import type { NotificationChannel } from '@/types';

const CHANNEL_ID_RE = /^[\w.-]+$/;
function isHttpUrl(u: string): boolean {
  try {
    const x = new URL(u.trim());
    return x.protocol === 'http:' || x.protocol === 'https:';
  } catch {
    return false;
  }
}

interface NotificationChannelDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  isEdit: boolean;
  /** Seed draft — a blank channel for create, the existing one for edit. */
  initial: NotificationChannel;
  /** Ids of every other channel, for the duplicate check. */
  otherIds: string[];
  onSubmit: (channel: NotificationChannel) => void;
}

export function NotificationChannelDialog(props: NotificationChannelDialogProps) {
  const { open, onOpenChange, isEdit, initial, otherIds, onSubmit } = props;
  // Parent unmounts on close, so each open re-seeds via lazy init.
  const [draft, setDraft] = useState<NotificationChannel>(initial);
  const patch = (p: Partial<NotificationChannel>) => setDraft({ ...draft, ...p });

  const id = draft.id.trim();
  const idBlank = id.length === 0;
  const idBad = !idBlank && (!CHANNEL_ID_RE.test(id) || id.length > 64);
  const idDup = !idBlank && otherIds.includes(id);
  const urlBlank = draft.url.trim().length === 0;
  const urlBad = !urlBlank && !isHttpUrl(draft.url);
  const canSave = !idBlank && !idBad && !idDup && !urlBlank && !urlBad;

  const idError = idBlank
    ? '请填写渠道 ID'
    : idBad
      ? '只能用字母 / 数字 / . _ - ，≤64 字符'
      : idDup
        ? 'ID 与其它渠道重复'
        : undefined;
  const urlError = urlBlank ? '请填写 Webhook URL' : urlBad ? '必须是 http(s) 地址' : undefined;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? '编辑渠道' : '新建渠道'}</DialogTitle>
          <DialogDescription>账号上线 / 下线时向该 Webhook POST 一条渲染后的通知。</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <div className="grid gap-3 sm:grid-cols-2">
            <Field
              label="渠道 ID"
              placeholder="dingtalk"
              value={draft.id}
              disabled={isEdit}
              hint={isEdit ? '创建后不可更改' : '账号据此勾选；字母/数字/. _ -'}
              error={idError}
              onChange={(v) => patch({ id: v })}
            />
            <Field
              label="显示名"
              placeholder="钉钉群机器人"
              value={draft.name}
              onChange={(v) => patch({ name: v })}
            />
          </div>

          <Field
            label="Webhook URL"
            type="url"
            placeholder="https://oapi.dingtalk.com/robot/send?access_token=…"
            value={draft.url}
            error={urlError}
            onChange={(v) => patch({ url: v })}
          />

          <div className="flex flex-col gap-1.5">
            <Label>Body 模板</Label>
            <Textarea
              value={draft.bodyTemplate}
              rows={3}
              spellCheck={false}
              onChange={(e) => patch({ bodyTemplate: e.target.value })}
              className="font-mono text-xs leading-relaxed"
            />
            <p className="text-[11px] leading-relaxed text-muted-foreground">
              变量：<code className="font-mono">{'{uin}'}</code> <code className="font-mono">{'{nickname}'}</code>{' '}
              <code className="font-mono">{'{event}'}</code>（offline/online） <code className="font-mono">{'{time}'}</code>
            </p>
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-card/40 p-3">
            <div className="min-w-0">
              <Label className="text-sm">启用</Label>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                关闭后保留配置但不推送；账号侧对应开关会被锁定并关闭。
              </p>
            </div>
            <ToggleSwitch value={draft.enabled} onChange={(v) => patch({ enabled: v })} ariaLabel="启用渠道" />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onSubmit({ ...draft, id, name: draft.name.trim(), url: draft.url.trim() });
              onOpenChange(false);
            }}
          >
            {isEdit ? '保存修改' : '创建渠道'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

interface FieldProps {
  label: string;
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'url';
  error?: string;
  hint?: string;
  disabled?: boolean;
}

function Field({ label, value, onChange, placeholder, type = 'text', error, hint, disabled }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value}
        disabled={disabled}
        placeholder={placeholder}
        onChange={(e) => onChange(e.target.value)}
        className={cn(error && 'border-destructive focus-visible:ring-destructive/40', disabled && 'opacity-60')}
      />
      {error ? (
        <p className="text-[11px] text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-[11px] text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
