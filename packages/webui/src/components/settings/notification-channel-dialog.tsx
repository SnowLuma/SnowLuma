// Modal editor for a notification channel — used for both create and edit,
// mirroring NodeEditDialog. Holds a local draft until 保存 (cancel discards).
// The channel id is the stable key per-account opt-ins reference, so it's
// editable only on create and locked on edit.
import { useState } from 'react';
import { Plus, Trash2 } from 'lucide-react';
import { Modal } from '@/components/interior/modal';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Textarea } from '@/components/ui/textarea';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { cn } from '@/lib/utils';
import type { NotificationChannel } from '@/types';

interface HeaderRow {
  name: string;
  value: string;
}

function headersToRows(headers?: Record<string, string>): HeaderRow[] {
  const rows = Object.entries(headers ?? {}).map(([name, value]) => ({ name, value }));
  return rows.length > 0 ? rows : [{ name: '', value: '' }];
}

function rowsToHeaders(rows: HeaderRow[]): Record<string, string> | undefined {
  const out: Record<string, string> = {};
  for (const row of rows) {
    const name = row.name.trim();
    const value = row.value.trim();
    if (!name || !value) continue;
    out[name] = value;
  }
  return Object.keys(out).length > 0 ? out : undefined;
}

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
  const [headerRows, setHeaderRows] = useState<HeaderRow[]>(() => headersToRows(initial.headers));
  const patch = (p: Partial<NotificationChannel>) => setDraft({ ...draft, ...p });
  const patchHeader = (index: number, p: Partial<HeaderRow>) => {
    setHeaderRows(headerRows.map((row, i) => (i === index ? { ...row, ...p } : row)));
  };

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
    <Modal
      open={open}
      onClose={() => onOpenChange(false)}
      title={isEdit ? '编辑渠道' : '新建渠道'}
      description="账号上线 / 下线时向该 Webhook POST 一条渲染后的通知。"
      closeLabel="关闭渠道编辑弹窗"
      maxWidth={576}
      footer={(
        <>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              onSubmit({
                ...draft,
                id,
                name: draft.name.trim(),
                url: draft.url.trim(),
                headers: rowsToHeaders(headerRows),
              });
              onOpenChange(false);
            }}
          >
            {isEdit ? '保存修改' : '创建渠道'}
          </Button>
        </>
      )}
    >
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
          <div className="flex items-center justify-between gap-2">
            <Label>请求头</Label>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              onClick={() => setHeaderRows([...headerRows, { name: '', value: '' }])}
            >
              <Plus className="size-3.5" />
              添加
            </Button>
          </div>
          <div className="flex flex-col gap-2">
            {headerRows.map((row, i) => (
              <div key={i} className="flex items-center gap-2">
                <Input
                  value={row.name}
                  placeholder="Authorization"
                  spellCheck={false}
                  onChange={(e) => patchHeader(i, { name: e.target.value })}
                  className="font-mono text-xs"
                />
                <Input
                  value={row.value}
                  placeholder="Bearer …"
                  spellCheck={false}
                  onChange={(e) => patchHeader(i, { value: e.target.value })}
                  className="font-mono text-xs"
                />
                <Button
                  type="button"
                  variant="ghost"
                  size="icon-sm"
                  aria-label="删除请求头"
                  onClick={() => {
                    const next = headerRows.filter((_, idx) => idx !== i);
                    setHeaderRows(next.length > 0 ? next : [{ name: '', value: '' }]);
                  }}
                  className="shrink-0 text-muted-foreground hover:text-foreground"
                >
                  <Trash2 className="size-3.5" />
                </Button>
              </div>
            ))}
          </div>
          <p className="text-xs leading-relaxed text-muted-foreground">
            可选。用于飞书等需要鉴权头的 Webhook；默认仍带 JSON Content-Type。
          </p>
        </div>

        <div className="flex flex-col gap-1.5">
          <Label>Body 模板</Label>
          <Textarea
            value={draft.bodyTemplate}
            rows={3}
            spellCheck={false}
            onChange={(e) => patch({ bodyTemplate: e.target.value })}
            className="font-mono text-xs leading-relaxed"
          />
          <p className="text-xs leading-relaxed text-muted-foreground">
              变量：<code className="font-mono">{'{uin}'}</code> <code className="font-mono">{'{nickname}'}</code>{' '}
            <code className="font-mono">{'{event}'}</code>（offline/online） <code className="font-mono">{'{time}'}</code>
          </p>
        </div>

        <div className="flex items-center justify-between rounded-lg border bg-card/40 p-3">
          <div className="min-w-0">
            <Label className="text-sm">启用</Label>
            <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
                关闭后保留配置但不推送；账号侧对应开关会被锁定并关闭。
            </p>
          </div>
          <ToggleSwitch value={draft.enabled} onChange={(v) => patch({ enabled: v })} ariaLabel="启用渠道" />
        </div>
      </div>
    </Modal>
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
        <p className="text-xs text-destructive">{error}</p>
      ) : hint ? (
        <p className="text-xs text-muted-foreground">{hint}</p>
      ) : null}
    </div>
  );
}
