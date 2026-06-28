// Modal editor used for both "create" and "edit". Holds a local draft
// copy of the adapter until the user clicks save (so cancel really does
// throw away changes). Validation is minimal — blank-name and dup-name
// disable the save button; everything else is best-effort coercion.
//
// Visual language: Apple-HIG grouped-list flavour (matches debug-page) —
// captioned sections, soft rounded cards, settings rows with a label on the
// left and a control (toggle / custom dropdown) on the right.

import { useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  ArrowLeftRight,
  ArrowUpRight,
  Check,
  Copy,
  Eye,
  EyeOff,
  Radio,
  Server,
  type LucideIcon,
} from 'lucide-react';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { DropdownSelect, type DropdownOption } from '@/components/ui/dropdown-select';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
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

const KIND_ICON: Record<NetworkKind, LucideIcon> = {
  httpServers: Server,
  httpClients: ArrowUpRight,
  wsServers: Radio,
  wsClients: ArrowLeftRight,
};

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
  const Icon: LucideIcon = KIND_ICON[kind];

  // Local draft. The parent unmounts this component on close so each
  // open gets a fresh `initial` via useState's lazy init — no effect-based
  // resync needed, which keeps the lifecycle linear.
  const [draft, setDraft] = useState<AnyAdapter<K>>(initial);

  const trimmedName = draft.name?.trim() ?? '';
  const blankName = trimmedName.length === 0;
  const duplicateName = !blankName && otherNames.includes(trimmedName);

  const canSave = !blankName && !duplicateName;

  const patch = (changes: Partial<AnyAdapter<K>>) => setDraft({ ...draft, ...changes } as AnyAdapter<K>);

  const isWs = kind === 'wsServers' || kind === 'wsClients';
  const role = ((draft as WsServerNetwork | WsClientNetwork).role ?? 'Universal') as WsRole;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-xl">
        <DialogHeader>
          <div className="flex items-center gap-3">
            <div className="flex size-11 shrink-0 items-center justify-center rounded-2xl bg-primary/10 text-primary">
              <Icon className="size-5" />
            </div>
            <div className="min-w-0">
              <DialogTitle>{isEdit ? `编辑 ${tab.noun}` : `新建 ${tab.noun}`}</DialogTitle>
              <DialogDescription className="mt-0.5">{tab.description}</DialogDescription>
            </div>
          </div>
        </DialogHeader>

        <div className="flex flex-col gap-5">
          <motion.div
            initial={{ opacity: 0, y: 8 }}
            animate={{ opacity: 1, y: 0 }}
            transition={{ duration: 0.3, delay: 0 }}
            className="flex items-center justify-between gap-4 rounded-2xl border border-border/60 bg-card/60 px-4 py-3.5 shadow-[0_1px_2px_rgb(0_0_0/0.04)]"
          >
            <div className="min-w-0">
              <Label className="text-sm font-medium text-foreground">启用</Label>
              <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">
                关闭后保存即可保留配置但不启动该节点
              </p>
            </div>
            <ToggleSwitch
              value={draft.enabled !== false}
              onChange={(v) => patch({ enabled: v ? undefined : false } as Partial<AnyAdapter<K>>)}
              ariaLabel="启用"
            />
          </motion.div>

          <Section caption="连接" delay={0.05}>
            <div className="flex flex-col gap-3 p-4">
              <Field
                label="名称"
                placeholder="自定义"
                value={draft.name}
                onChange={(v) => patch({ name: v } as Partial<AnyAdapter<K>>)}
                error={blankName ? '请填写名称' : duplicateName ? '名称与其它节点重复' : undefined}
              />
              <KindFields kind={kind} draft={draft} patch={patch} />
            </div>
          </Section>

          <Section caption="鉴权" delay={0.1}>
            <div className="p-4">
              <TokenField
                label="授权 Token"
                placeholder="不填则无密码"
                value={draft.accessToken}
                onChange={(v) => patch({ accessToken: v || undefined } as Partial<AnyAdapter<K>>)}
              />
            </div>
          </Section>

          <Section caption="行为" delay={0.15}>
            <div className="divide-y divide-border/60">
              <SettingRow label="消息格式" desc="数组为标准 OneBot 段，CQ 码为兼容字符串">
                <DropdownSelect
                  className="w-32"
                  ariaLabel="消息格式"
                  value={(draft.messageFormat ?? 'array') as MessageFormat}
                  options={FORMAT_OPTIONS}
                  onChange={(v) => patch({ messageFormat: v } as Partial<AnyAdapter<K>>)}
                />
              </SettingRow>

              {isWs && (
                <SettingRow label="角色" desc="Universal 收发合一，Event / Api 分离">
                  <DropdownSelect
                    className="w-32"
                    ariaLabel="角色"
                    value={role}
                    options={WS_ROLE_OPTIONS}
                    onChange={(v) => patch({ role: v } as unknown as Partial<AnyAdapter<K>>)}
                  />
                </SettingRow>
              )}

              <SettingRow label="上报自身消息" desc="将机器人自己发送的消息也作为 message_sent 事件上报">
                <ToggleSwitch
                  value={!!draft.reportSelfMessage}
                  onChange={(v) => patch({ reportSelfMessage: v } as Partial<AnyAdapter<K>>)}
                  ariaLabel="上报自身消息"
                />
              </SettingRow>
            </div>
          </Section>
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

// ─────────────── grouped-list scaffolding ───────────────

/** Captioned inset section — the iOS "grouped list" unit. */
function Section({ caption, delay, children }: { caption: string; delay: number; children: ReactNode }) {
  return (
    <motion.section
      initial={{ opacity: 0, y: 8 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.3, delay }}
      className="flex flex-col gap-1.5"
    >
      <span className="px-1 text-[11px] font-medium text-muted-foreground">{caption}</span>
      <div className="overflow-hidden rounded-2xl border border-border/60 bg-card/40">{children}</div>
    </motion.section>
  );
}

/** Settings row — label (+ optional subtitle) on the left, control on the right. */
function SettingRow({ label, desc, children }: { label: string; desc?: string; children: ReactNode }) {
  return (
    <div className="flex items-center justify-between gap-4 px-4 py-3">
      <div className="min-w-0">
        <Label className="text-[13px] text-foreground">{label}</Label>
        {desc && <p className="mt-0.5 text-[11px] leading-relaxed text-muted-foreground">{desc}</p>}
      </div>
      <div className="shrink-0">{children}</div>
    </div>
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
  // each arm casts once. Field components receive specific shapes. The WS
  // `role` lives in the behaviour section, so it is intentionally absent here.
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
  if (kind === 'wsClients') {
    const it = draft as WsClientNetwork;
    const set = patch as (c: Partial<WsClientNetwork>) => void;
    return (
      <div className="grid gap-3 sm:grid-cols-[1fr_160px]">
        <Field
          label="目标 URL"
          type="url"
          placeholder="ws://..."
          value={it.url}
          onChange={(v) => set({ url: v })}
        />
        <Field
          label="重连间隔 (ms)"
          type="number"
          value={it.reconnectIntervalMs}
          onChange={(v) => set({ reconnectIntervalMs: Number(v) || undefined })}
        />
      </div>
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

const FORMAT_OPTIONS: ReadonlyArray<DropdownOption<MessageFormat>> = [
  { value: 'array', label: '数组' },
  { value: 'string', label: 'CQ 码' },
];

const WS_ROLE_OPTIONS: ReadonlyArray<DropdownOption<WsRole>> = [
  { value: 'Universal', label: 'Universal' },
  { value: 'Event', label: 'Event' },
  { value: 'Api', label: 'Api' },
];
