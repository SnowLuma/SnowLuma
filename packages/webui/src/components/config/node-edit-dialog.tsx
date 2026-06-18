// Modal editor used for both "create" and "edit". Holds a local draft
// copy of the adapter until the user clicks save (so cancel really does
// throw away changes). Validation is minimal — blank-name and dup-name
// disable the save button; everything else is best-effort coercion.

import { useRef, useState } from 'react';
import { Check, Copy, Eye, EyeOff } from 'lucide-react';
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
import { Select } from '@/components/ui/select';
import { cn } from '@/lib/utils';
import type {
  HttpClientNetwork,
  HttpServerNetwork,
  MessageFormat,
  NetworkKind,
  OneBotNetworks,
  WsClientNetwork,
  WsRole,
  WsServerNetwork,
} from '@/types';
import { NETWORK_TABS } from './defaults';

type AnyAdapter<K extends NetworkKind> = OneBotNetworks[K][number];

interface NodeEditDialogProps<K extends NetworkKind> {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  kind: K;
  /** Initial draft state — caller seeds it with `defaultEntry` for create
   *  or the existing item for edit. */
  initial: AnyAdapter<K>;
  /** True when editing an existing adapter (drives title + button copy). */
  isEdit: boolean;
  /** Names of every other adapter in the same list, for duplicate check. */
  otherNames: string[];
  onSubmit: (item: AnyAdapter<K>) => void;
}

export function NodeEditDialog<K extends NetworkKind>(props: NodeEditDialogProps<K>) {
  const { open, onOpenChange, kind, initial, isEdit, otherNames, onSubmit } = props;
  const tab = NETWORK_TABS[kind];

  // Local draft. The parent unmounts this component on close so each
  // open gets a fresh `initial` via useState's lazy init — no effect-based
  // resync needed, which keeps the lifecycle linear.
  const [draft, setDraft] = useState<AnyAdapter<K>>(initial);

  const trimmedName = draft.name?.trim() ?? '';
  const blankName = trimmedName.length === 0;
  const duplicateName = !blankName && otherNames.includes(trimmedName);

  const canSave = !blankName && !duplicateName;

  const patch = (changes: Partial<AnyAdapter<K>>) => setDraft({ ...draft, ...changes } as AnyAdapter<K>);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <DialogTitle>{isEdit ? `编辑 ${tab.noun}` : `新建 ${tab.noun}`}</DialogTitle>
          <DialogDescription>{tab.description}</DialogDescription>
        </DialogHeader>

        <div className="flex flex-col gap-3">
          <Field
            label="名称"
            placeholder="自定义"
            value={draft.name}
            onChange={(v) => patch({ name: v } as Partial<AnyAdapter<K>>)}
            error={blankName ? '请填写名称' : duplicateName ? '名称与其它节点重复' : undefined}
          />

          <KindFields kind={kind} draft={draft} patch={patch} />

          <TokenField
            label="授权 Token"
            placeholder="不填则无密码"
            value={draft.accessToken}
            onChange={(v) => patch({ accessToken: v || undefined } as Partial<AnyAdapter<K>>)}
          />

          <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
            <SegmentedField
              label="消息格式"
              value={(draft.messageFormat ?? 'array') as MessageFormat}
              options={FORMAT_OPTIONS}
              onChange={(v) => patch({ messageFormat: v } as Partial<AnyAdapter<K>>)}
            />
            <SegmentedField
              label="上报自身消息"
              value={draft.reportSelfMessage ? 'on' : 'off'}
              options={REPORT_OPTIONS}
              onChange={(v) => patch({ reportSelfMessage: v === 'on' } as Partial<AnyAdapter<K>>)}
            />
          </div>

          <div className="flex items-center justify-between rounded-lg border bg-card/40 p-3">
            <div>
              <Label className="text-sm">启用</Label>
              <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">
                关闭后保存即可保留配置但不启动该节点
              </p>
            </div>
            <ToggleSwitch
              value={draft.enabled !== false}
              onChange={(v) =>
                patch({ enabled: v ? undefined : false } as Partial<AnyAdapter<K>>)
              }
              ariaLabel="启用"
            />
          </div>
        </div>

        <DialogFooter>
          <Button variant="outline" onClick={() => onOpenChange(false)}>
            取消
          </Button>
          <Button
            disabled={!canSave}
            onClick={() => {
              const cleaned = { ...draft, name: trimmedName } as AnyAdapter<K>;
              onSubmit(cleaned);
              onOpenChange(false);
            }}
          >
            {isEdit ? '保存修改' : '创建节点'}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

// ─────────────── kind-specific field strips ───────────────

interface KindFieldsProps<K extends NetworkKind> {
  kind: K;
  draft: AnyAdapter<K>;
  patch: (changes: Partial<AnyAdapter<K>>) => void;
}

function KindFields<K extends NetworkKind>({ kind, draft, patch }: KindFieldsProps<K>) {
  // Per-branch narrowing — TS can't follow the generic relationship so
  // each arm casts once. Field components receive specific shapes.
  if (kind === 'httpServers') {
    const it = draft as HttpServerNetwork;
    const set = patch as (c: Partial<HttpServerNetwork>) => void;
    return (
      <div className="grid gap-3 sm:grid-cols-[1fr_120px_140px]">
        <Field
          label="主机"
          placeholder="0.0.0.0"
          value={it.host}
          onChange={(v) => set({ host: v || undefined })}
        />
        <Field
          label="端口"
          type="number"
          value={it.port}
          onChange={(v) => set({ port: Number(v) || 0 })}
        />
        <Field
          label="路径"
          placeholder="/"
          value={it.path}
          onChange={(v) => set({ path: v || undefined })}
        />
      </div>
    );
  }
  if (kind === 'httpClients') {
    const it = draft as HttpClientNetwork;
    const set = patch as (c: Partial<HttpClientNetwork>) => void;
    return (
      <div className="grid gap-3 sm:grid-cols-[1fr_140px]">
        <Field
          label="目标 URL"
          type="url"
          placeholder="http://..."
          value={it.url}
          onChange={(v) => set({ url: v })}
        />
        <Field
          label="超时 (ms)"
          type="number"
          placeholder="5000"
          value={it.timeoutMs}
          onChange={(v) => set({ timeoutMs: Number(v) || undefined })}
        />
      </div>
    );
  }
  if (kind === 'wsServers') {
    const it = draft as WsServerNetwork;
    const set = patch as (c: Partial<WsServerNetwork>) => void;
    return (
      <>
        <div className="grid gap-3 sm:grid-cols-[1fr_120px_140px]">
          <Field
            label="主机"
            placeholder="0.0.0.0"
            value={it.host}
            onChange={(v) => set({ host: v || undefined })}
          />
          <Field
            label="端口"
            type="number"
            value={it.port}
            onChange={(v) => set({ port: Number(v) || 0 })}
          />
          <Field
            label="路径"
            placeholder="/"
            value={it.path}
            onChange={(v) => set({ path: v || undefined })}
          />
        </div>
        <SelectField
          label="角色"
          value={(it.role ?? 'Universal') as WsRole}
          options={WS_ROLE_OPTIONS}
          onChange={(v) => set({ role: v })}
        />
      </>
    );
  }
  if (kind === 'wsClients') {
    const it = draft as WsClientNetwork;
    const set = patch as (c: Partial<WsClientNetwork>) => void;
    return (
      <>
        <Field
          label="目标 URL"
          type="url"
          placeholder="ws://..."
          value={it.url}
          onChange={(v) => set({ url: v })}
        />
        <div className="grid gap-3 sm:grid-cols-2">
          <SelectField
            label="角色"
            value={(it.role ?? 'Universal') as WsRole}
            options={WS_ROLE_OPTIONS}
            onChange={(v) => set({ role: v })}
          />
          <Field
            label="重连间隔 (ms)"
            type="number"
            value={it.reconnectIntervalMs}
            onChange={(v) => set({ reconnectIntervalMs: Number(v) || undefined })}
          />
        </div>
      </>
    );
  }
  return null;
}

// ─────────────── shared form bits ───────────────

interface FieldProps {
  label: string;
  value: string | number | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'number' | 'url';
  error?: string;
}

function Field({ label, value, onChange, placeholder, type = 'text', error }: FieldProps) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
        className={cn(error && 'border-destructive focus-visible:ring-destructive/40')}
      />
      {error && <p className="text-[11px] text-destructive">{error}</p>}
    </div>
  );
}

interface TokenFieldProps {
  label: string;
  value: string | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
}

/** Insecure-context clipboard fallback. Returns true on success.
 *  Cast through a local alias so ts(6387) doesn't flag the call site —
 *  the deprecation tag is on the live signature and we know we're using
 *  the still-supported legacy form on purpose. */
function legacyCopyToClipboard(value: string): boolean {
  try {
    const ta = document.createElement('textarea');
    ta.value = value;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const exec = (document as unknown as { execCommand(cmd: string): boolean }).execCommand;
    const ok = exec.call(document, 'copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/**
 * Password-style input for the access token. Hidden by default to keep
 * the value out of over-the-shoulder reads / screenshots; an eye toggle
 * unmasks it and a copy button shoves the current value to the system
 * clipboard with a short "已复制" confirmation flash.
 */
function TokenField({ label, value, onChange, placeholder }: TokenFieldProps) {
  const [visible, setVisible] = useState(false);
  const [copied, setCopied] = useState(false);
  const copiedTimerRef = useRef<number | null>(null);

  const handleCopy = async () => {
    if (!value) return;
    try {
      await navigator.clipboard.writeText(value);
    } catch {
      // navigator.clipboard is undefined on insecure origins (LAN HTTP
      // outside localhost). Fall back to a transient textarea +
      // document.execCommand('copy'). The latter is deprecated but every
      // current browser still honours it and there is no modern
      // replacement for non-secure-context clipboard writes.
      if (!legacyCopyToClipboard(value)) return;
    }
    setCopied(true);
    if (copiedTimerRef.current != null) window.clearTimeout(copiedTimerRef.current);
    copiedTimerRef.current = window.setTimeout(() => {
      setCopied(false);
      copiedTimerRef.current = null;
    }, 1400);
  };

  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex gap-1.5">
        <Input
          // Switch input type rather than masking the string so paste /
          // selection / autofill all behave like a native password field.
          type={visible ? 'text' : 'password'}
          value={value ?? ''}
          onChange={(e) => onChange(e.target.value)}
          placeholder={placeholder}
          autoComplete="off"
          spellCheck={false}
          className="flex-1 font-mono"
        />
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={handleCopy}
          disabled={!value}
          aria-label={copied ? '已复制' : '复制'}
          title={copied ? '已复制' : '复制'}
        >
          {copied ? <Check className="size-4 text-success" /> : <Copy className="size-4" />}
        </Button>
        <Button
          type="button"
          variant="outline"
          size="icon"
          onClick={() => setVisible((v) => !v)}
          aria-label={visible ? '隐藏' : '显示'}
          title={visible ? '隐藏' : '显示'}
        >
          {visible ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
        </Button>
      </div>
    </div>
  );
}

interface SegmentedOption<T extends string> {
  value: T;
  label: string;
}

function SegmentedField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <div className="flex flex-wrap gap-1 rounded-md border bg-muted/30 p-1">
        {options.map((opt) => {
          const active = value === opt.value;
          return (
            <button
              key={opt.value}
              type="button"
              onClick={() => onChange(opt.value)}
              className={cn(
                'flex-1 rounded px-2.5 py-1 text-xs transition-colors cursor-pointer',
                active ? 'bg-primary text-primary-foreground' : 'text-muted-foreground hover:bg-accent/50',
              )}
            >
              {opt.label}
            </button>
          );
        })}
      </div>
    </div>
  );
}

function SelectField<T extends string>({
  label,
  value,
  options,
  onChange,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (v: T) => void;
}) {
  return (
    <div className="flex flex-col gap-1.5">
      <Label>{label}</Label>
      <Select value={value} onChange={(e) => onChange(e.target.value as T)}>
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </Select>
    </div>
  );
}

interface ToggleSwitchProps {
  value: boolean;
  onChange: (v: boolean) => void;
  ariaLabel: string;
}

function ToggleSwitch({ value, onChange, ariaLabel }: ToggleSwitchProps) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={value ? 'true' : 'false'}
      aria-label={ariaLabel}
      onClick={() => onChange(!value)}
      className={cn(
        'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors',
        value ? 'border-primary bg-primary' : 'border-input bg-muted',
      )}
    >
      <span
        className={cn(
          'inline-block size-4 rounded-full bg-background shadow-sm transition-transform',
          value ? 'translate-x-[22px]' : 'translate-x-1',
        )}
      />
    </button>
  );
}

const FORMAT_OPTIONS: ReadonlyArray<SegmentedOption<MessageFormat>> = [
  { value: 'array', label: '数组' },
  { value: 'string', label: 'CQ 码' },
];

const REPORT_OPTIONS: ReadonlyArray<SegmentedOption<'on' | 'off'>> = [
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
];

const WS_ROLE_OPTIONS: ReadonlyArray<SegmentedOption<WsRole>> = [
  { value: 'Universal', label: 'Universal' },
  { value: 'Event', label: 'Event' },
  { value: 'Api', label: 'Api' },
];
