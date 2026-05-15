import { useState } from 'react';
import { motion } from 'motion/react';
import { MousePointerClick, Plus, Save, Trash2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Avatar, AvatarFallback, AvatarImage } from '@/components/ui/avatar';
import { Badge } from '@/components/ui/badge';
import { Skeleton } from '@/components/ui/skeleton';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import type {
  MessageFormat,
  NetworkKind,
  OneBotConfig,
  OneBotNetworks,
  QQInfo,
  WsRole,
} from '@/types';
import { useOneBotInstanceConfig } from '@/hooks/use-onebot-instance-config';

interface ConfigPageProps {
  qqList: QQInfo[];
}

function qqAvatarUrl(uin: string) {
  return `/avatar/${encodeURIComponent(uin)}`;
}

function generateAccessToken(): string {
  const bytes = new Uint8Array(32);
  globalThis.crypto.getRandomValues(bytes);
  return Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
}

function Field({
  label,
  value,
  onChange,
  placeholder,
  type = 'text',
  className,
}: {
  label: string;
  value: string | number | undefined;
  onChange: (v: string) => void;
  placeholder?: string;
  type?: 'text' | 'number' | 'url';
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label>{label}</Label>
      <Input
        type={type}
        value={value ?? ''}
        onChange={(e) => onChange(e.target.value)}
        placeholder={placeholder}
      />
    </div>
  );
}

interface SectionProps {
  title: string;
  description?: string;
  onAdd?: () => void;
  children: React.ReactNode;
  count?: number;
}

function Section({ title, description, onAdd, children, count }: SectionProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-center justify-between gap-2 space-y-0">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <CardTitle className="text-sm">{title}</CardTitle>
            {typeof count === 'number' && <Badge variant="secondary">{count}</Badge>}
          </div>
          {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
        </div>
        {onAdd && (
          <Button size="sm" variant="outline" onClick={onAdd}>
            <Plus className="size-3.5" /> 添加
          </Button>
        )}
      </CardHeader>
      <CardContent className="flex flex-col gap-3 pt-0">{children}</CardContent>
    </Card>
  );
}

export function ConfigPage({ qqList }: ConfigPageProps) {
  const {
    selectedUin,
    config,
    setConfig,
    dirty,
    requestSwitchUin,
    pendingSwitchUin,
    confirmSwitch,
    cancelSwitch,
    save,
    saveStatus,
  } = useOneBotInstanceConfig(qqList);
  const [confirmSave, setConfirmSave] = useState(false);

  const update = (next: OneBotConfig) => setConfig(next);
  const pendingSwitchAccount = pendingSwitchUin
    ? qqList.find((q) => q.uin === pendingSwitchUin) ?? null
    : null;

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-[260px_minmax(0,1fr)]">
      {/* Account list */}
      <Card className="lg:sticky lg:top-2 lg:self-start">
        <CardHeader>
          <CardTitle className="text-sm">在线连接</CardTitle>
        </CardHeader>
        <CardContent className="pt-0">
          {qqList.length === 0 ? (
            <p className="py-6 text-center text-xs text-muted-foreground">暂无在线会话</p>
          ) : (
            <ScrollArea className="max-h-[60vh]" viewportClassName="[&>div]:!block">
              <div className="grid grid-cols-2 gap-1.5 lg:grid-cols-1">
                {qqList.map((q) => {
                  const isActive = selectedUin === q.uin;
                  return (
                    <motion.button
                      key={q.uin}
                      type="button"
                      whileHover={{ scale: 1.01 }}
                      whileTap={{ scale: 0.98 }}
                      onClick={() => requestSwitchUin(q.uin)}
                      className={cn(
                        'flex items-center gap-2.5 rounded-lg border px-2.5 py-2 text-left transition-colors cursor-pointer',
                        isActive ? 'border-primary/30 bg-primary/10' : 'border-transparent hover:bg-accent/40'
                      )}
                    >
                      <Avatar size={28}>
                        <AvatarImage src={qqAvatarUrl(q.uin)} alt={q.nickname || q.uin} />
                        <AvatarFallback>{(q.nickname || q.uin).slice(0, 2)}</AvatarFallback>
                      </Avatar>
                      <div className="min-w-0 flex-1">
                        <div
                          className={cn('truncate text-sm font-medium', isActive ? 'text-primary' : 'text-foreground')}
                        >
                          {q.nickname}
                        </div>
                        <div className="truncate font-mono text-[10px] text-muted-foreground tabular-nums">{q.uin}</div>
                      </div>
                    </motion.button>
                  );
                })}
              </div>
            </ScrollArea>
          )}
        </CardContent>
      </Card>

      {/* Editor */}
      <div className="min-w-0">
        {!selectedUin ? (
          <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground">
            <MousePointerClick className="size-7" strokeWidth={1.5} />
            <p className="text-sm">请在左栏选择会话以配置通信节点</p>
          </div>
        ) : !config ? (
          <div className="space-y-3">
            <Skeleton className="h-9 w-48" />
            <Skeleton className="h-32" />
            <Skeleton className="h-32" />
          </div>
        ) : (
          <div className="flex flex-col gap-4">
            {/* Header */}
            <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h2 className="text-base font-semibold tracking-tight">OneBot 协议端点</h2>
                <code className="mt-0.5 block font-mono text-xs text-muted-foreground tabular-nums">UIN {selectedUin}</code>
              </div>
              <div className="flex items-center gap-2">
                {saveStatus && (
                  <span
                    className={cn(
                      'rounded-full border px-2.5 py-1 text-[11px] font-medium',
                      saveStatus === '保存成功' && 'border-success/30 bg-success/10 text-success',
                      saveStatus === '保存中...' && 'border-border bg-muted text-muted-foreground',
                      saveStatus !== '保存成功' && saveStatus !== '保存中...' && 'border-destructive/30 bg-destructive/10 text-destructive'
                    )}
                  >
                    {saveStatus}
                  </span>
                )}
                {dirty && !saveStatus && (
                  <span className="rounded-full border border-warning/30 bg-warning/10 px-2.5 py-1 text-[11px] font-medium text-warning">
                    未保存
                  </span>
                )}
                <Button onClick={() => setConfirmSave(true)} size="sm" disabled={!dirty}>
                  <Save className="size-3.5" /> 保存设定
                </Button>
              </div>
            </div>

            <Section
              title="通用设置"
              description="OneBot 共享功能配置"
            >
              <Field
                label="音乐签名服务 URL"
                type="url"
                placeholder="留空则不启用"
                value={config.musicSignUrl}
                onChange={(v) => update({ ...config, musicSignUrl: v || undefined })}
              />
            </Section>

            {/* HTTP Servers */}
            <NetworkSection
              title="HTTP API 服务"
              description="本地监听 HTTP 端口，OneBot 客户端发起请求"
              kind="httpServers"
              networks={config.networks.httpServers}
              onChange={(arr) => updateNetworks(config, update, 'httpServers', arr)}
              renderFields={(item, patch) => (
                <>
                  <Field
                    label="主机"
                    placeholder="0.0.0.0"
                    value={item.host}
                    onChange={(v) => patch({ host: v || undefined })}
                    className="sm:w-40"
                  />
                  <Field
                    label="端口"
                    type="number"
                    value={item.port}
                    onChange={(v) => patch({ port: Number(v) || 0 })}
                    className="sm:w-28"
                  />
                  <Field
                    label="路径"
                    placeholder="/"
                    value={item.path}
                    onChange={(v) => patch({ path: v || undefined })}
                    className="sm:w-32"
                  />
                  <Field
                    label="授权 Token"
                    placeholder="不填则无密码"
                    value={item.accessToken}
                    onChange={(v) => patch({ accessToken: v || undefined })}
                    className="flex-1"
                  />
                </>
              )}
              defaultEntry={(suffix) => ({
                name: `http-${suffix}`,
                host: '0.0.0.0',
                port: 3000,
                path: '/',
                accessToken: generateAccessToken(),
                messageFormat: 'array',
                reportSelfMessage: false,
              })}
            />

            {/* HTTP Clients (POST push) */}
            <NetworkSection
              title="HTTP 推送客户端"
              description="主动向远端 URL POST 推送事件"
              kind="httpClients"
              networks={config.networks.httpClients}
              onChange={(arr) => updateNetworks(config, update, 'httpClients', arr)}
              renderFields={(item, patch) => (
                <>
                  <Field
                    label="目标 URL"
                    type="url"
                    placeholder="http://..."
                    value={item.url}
                    onChange={(v) => patch({ url: v })}
                    className="flex-1"
                  />
                  <Field
                    label="授权 Token"
                    placeholder="可选"
                    value={item.accessToken}
                    onChange={(v) => patch({ accessToken: v || undefined })}
                    className="sm:w-56"
                  />
                  <Field
                    label="超时 (ms)"
                    type="number"
                    placeholder="5000"
                    value={item.timeoutMs}
                    onChange={(v) => patch({ timeoutMs: Number(v) || undefined })}
                    className="sm:w-32"
                  />
                </>
              )}
              defaultEntry={(suffix) => ({
                name: `httppost-${suffix}`,
                url: 'http://127.0.0.1:5700',
                messageFormat: 'array',
                reportSelfMessage: false,
              })}
            />

            {/* WebSocket Servers */}
            <NetworkSection
              title="WebSocket 服务"
              description="本地监听 WebSocket 端口，客户端建立持久连接"
              kind="wsServers"
              networks={config.networks.wsServers}
              onChange={(arr) => updateNetworks(config, update, 'wsServers', arr)}
              renderFields={(item, patch) => (
                <>
                  <Field
                    label="主机"
                    placeholder="0.0.0.0"
                    value={item.host}
                    onChange={(v) => patch({ host: v || undefined })}
                    className="sm:w-40"
                  />
                  <Field
                    label="端口"
                    type="number"
                    value={item.port}
                    onChange={(v) => patch({ port: Number(v) || 0 })}
                    className="sm:w-28"
                  />
                  <Field
                    label="路径"
                    placeholder="/"
                    value={item.path}
                    onChange={(v) => patch({ path: v || undefined })}
                    className="sm:w-32"
                  />
                  <SelectField
                    label="角色"
                    value={item.role ?? 'Universal'}
                    options={WS_ROLE_OPTIONS}
                    onChange={(v) => patch({ role: v })}
                    className="sm:w-32"
                  />
                  <Field
                    label="授权 Token"
                    placeholder="不填则无密码"
                    value={item.accessToken}
                    onChange={(v) => patch({ accessToken: v || undefined })}
                    className="flex-1"
                  />
                </>
              )}
              defaultEntry={(suffix) => ({
                name: `ws-${suffix}`,
                host: '0.0.0.0',
                port: 3001,
                path: '/',
                role: 'Universal' as WsRole,
                accessToken: generateAccessToken(),
                messageFormat: 'array',
                reportSelfMessage: false,
              })}
            />

            {/* WebSocket Clients (reverse) */}
            <NetworkSection
              title="WebSocket 反向客户端"
              description="主动连接到外部 WebSocket 服务器（reverse-ws）"
              kind="wsClients"
              networks={config.networks.wsClients}
              onChange={(arr) => updateNetworks(config, update, 'wsClients', arr)}
              renderFields={(item, patch) => (
                <>
                  <Field
                    label="目标 URL"
                    type="url"
                    placeholder="ws://..."
                    value={item.url}
                    onChange={(v) => patch({ url: v })}
                    className="flex-1"
                  />
                  <SelectField
                    label="角色"
                    value={item.role ?? 'Universal'}
                    options={WS_ROLE_OPTIONS}
                    onChange={(v) => patch({ role: v })}
                    className="sm:w-32"
                  />
                  <Field
                    label="重连间隔 (ms)"
                    type="number"
                    value={item.reconnectIntervalMs}
                    onChange={(v) => patch({ reconnectIntervalMs: Number(v) || undefined })}
                    className="sm:w-36"
                  />
                  <Field
                    label="授权 Token"
                    placeholder="可选"
                    value={item.accessToken}
                    onChange={(v) => patch({ accessToken: v || undefined })}
                    className="sm:w-56"
                  />
                </>
              )}
              defaultEntry={(suffix) => ({
                name: `wsclient-${suffix}`,
                url: 'ws://127.0.0.1:8080/ws',
                role: 'Universal' as WsRole,
                reconnectIntervalMs: 5000,
                messageFormat: 'array',
                reportSelfMessage: false,
              })}
            />
          </div>
        )}
      </div>

      <ConfirmDialog
        open={confirmSave}
        onOpenChange={setConfirmSave}
        title="保存配置变更？"
        description={`即将把当前修改保存到 UIN ${selectedUin ?? ''} 的配置文件，并尝试热重载该会话。`}
        confirmText="保存"
        onConfirm={save}
      />

      <ConfirmDialog
        open={pendingSwitchUin != null}
        onOpenChange={(open) => !open && cancelSwitch()}
        title="放弃未保存的修改？"
        description={
          <>
            <p>
              当前会话 <code className="font-mono">{selectedUin}</code> 还有未保存的修改。
            </p>
            <p className="mt-2">
              切换到 <code className="font-mono">{pendingSwitchAccount?.uin ?? pendingSwitchUin}</code>
              {pendingSwitchAccount?.nickname ? `（${pendingSwitchAccount.nickname}）` : ''} 会丢弃这些修改。
            </p>
          </>
        }
        confirmText="放弃并切换"
        destructive
        onConfirm={confirmSwitch}
      />
    </div>
  );
}

function EmptyHint({ label }: { label: string }) {
  return (
    <div className="rounded-md border border-dashed py-6 text-center text-xs text-muted-foreground">{label}</div>
  );
}

interface ToggleFieldProps {
  label: string;
  description?: string;
  value: boolean;
  onChange: (v: boolean) => void;
}

function ToggleField({ label, description, value, onChange }: ToggleFieldProps) {
  return (
    <div className="flex items-start justify-between gap-3 rounded-lg border bg-card/40 p-3">
      <div className="min-w-0 flex-1">
        <Label className="text-sm">{label}</Label>
        {description && (
          <p className="mt-1 text-[11px] leading-relaxed text-muted-foreground">{description}</p>
        )}
      </div>
      <button
        type="button"
        role="switch"
        aria-checked={value}
        aria-label={label}
        onClick={() => onChange(!value)}
        className={cn(
          'relative inline-flex h-6 w-11 shrink-0 cursor-pointer items-center rounded-full border transition-colors',
          value
            ? 'border-primary bg-primary'
            : 'border-input bg-muted',
        )}
      >
        <motion.span
          className="inline-block size-4 rounded-full bg-background shadow-sm"
          animate={{ x: value ? 22 : 4 }}
          transition={{ type: 'spring', stiffness: 500, damping: 30 }}
        />
      </button>
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
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
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
                active
                  ? 'bg-primary text-primary-foreground'
                  : 'text-muted-foreground hover:bg-accent/50',
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
  className,
}: {
  label: string;
  value: T;
  options: ReadonlyArray<SegmentedOption<T>>;
  onChange: (v: T) => void;
  className?: string;
}) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <Label>{label}</Label>
      <select
        value={value}
        onChange={(e) => onChange(e.target.value as T)}
        className="h-9 rounded-md border bg-background px-2 text-sm shadow-xs"
      >
        {options.map((opt) => (
          <option key={opt.value} value={opt.value}>
            {opt.label}
          </option>
        ))}
      </select>
    </div>
  );
}

const ADAPTER_FORMAT_OPTIONS: ReadonlyArray<SegmentedOption<MessageFormat>> = [
  { value: 'array', label: '数组' },
  { value: 'string', label: 'CQ 码' },
];

const ADAPTER_REPORT_OPTIONS: ReadonlyArray<SegmentedOption<'on' | 'off'>> = [
  { value: 'on', label: '开启' },
  { value: 'off', label: '关闭' },
];

const WS_ROLE_OPTIONS: ReadonlyArray<SegmentedOption<WsRole>> = [
  { value: 'Universal', label: 'Universal' },
  { value: 'Event', label: 'Event' },
  { value: 'Api', label: 'Api' },
];

interface BaseAdapter {
  name: string;
  enabled?: boolean;
  accessToken?: string;
  messageFormat: MessageFormat;
  reportSelfMessage: boolean;
}

interface NetworkSectionProps<T extends BaseAdapter> {
  title: string;
  description?: string;
  kind: NetworkKind;
  networks: T[];
  onChange: (next: T[]) => void;
  renderFields: (item: T, patch: (changes: Partial<T>) => void) => React.ReactNode;
  defaultEntry: (suffix: number) => T;
}

function NetworkSection<T extends BaseAdapter>({
  title,
  description,
  networks,
  onChange,
  renderFields,
  defaultEntry,
}: NetworkSectionProps<T>) {
  const handleAdd = () => {
    const used = new Set(networks.map((n) => n.name));
    let suffix = networks.length + 1;
    let entry = defaultEntry(suffix);
    while (used.has(entry.name)) {
      suffix += 1;
      entry = defaultEntry(suffix);
    }
    onChange([...networks, entry]);
  };

  const patchAt = (idx: number, changes: Partial<T>) => {
    onChange(networks.map((it, i) => (i === idx ? { ...it, ...changes } : it)));
  };

  const removeAt = (idx: number) => {
    onChange(networks.filter((_, i) => i !== idx));
  };

  return (
    <Section title={title} description={description} count={networks.length} onAdd={handleAdd}>
      {networks.length === 0 ? (
        <EmptyHint label="暂无适配器，点击右上角『添加』新建" />
      ) : (
        networks.map((item, idx) => (
          <AdapterRow
            key={`${item.name}-${idx}`}
            item={item}
            otherNames={networks.filter((_, i) => i !== idx).map((n) => n.name)}
            onPatch={(changes) => patchAt(idx, changes)}
            onRemove={() => removeAt(idx)}
            renderFields={renderFields}
          />
        ))
      )}
    </Section>
  );
}

interface AdapterRowProps<T extends BaseAdapter> {
  item: T;
  otherNames: string[];
  onPatch: (changes: Partial<T>) => void;
  onRemove: () => void;
  renderFields: (item: T, patch: (changes: Partial<T>) => void) => React.ReactNode;
}

function AdapterRow<T extends BaseAdapter>({
  item,
  otherNames,
  onPatch,
  onRemove,
  renderFields,
}: AdapterRowProps<T>) {
  const enabled = item.enabled !== false;
  const duplicateName = !!item.name && otherNames.includes(item.name);
  const blankName = !item.name?.trim();

  const formatValue: MessageFormat = item.messageFormat ?? 'array';
  const reportValue: 'on' | 'off' = item.reportSelfMessage ? 'on' : 'off';

  return (
    <motion.div
      initial={{ opacity: 0, y: 4 }}
      animate={{ opacity: 1, y: 0 }}
      transition={{ duration: 0.18 }}
      className={cn(
        'flex flex-col gap-3 rounded-lg border bg-card/40 p-3',
        !enabled && 'opacity-60',
      )}
    >
      <div className="flex flex-wrap items-end gap-3">
        <Field
          label="名称"
          placeholder="自定义"
          value={item.name}
          onChange={(v) => onPatch({ name: v } as Partial<T>)}
          className="sm:w-44"
        />
        <ToggleField
          label="启用"
          value={enabled}
          onChange={(v) => onPatch({ enabled: v ? undefined : false } as Partial<T>)}
        />
        <Button
          variant="ghost"
          size="icon-sm"
          onClick={onRemove}
          aria-label="删除"
          className="ml-auto self-center text-muted-foreground hover:text-destructive"
        >
          <Trash2 className="size-4" />
        </Button>
      </div>
      {(blankName || duplicateName) && (
        <p className="text-[11px] text-destructive">
          {blankName ? '请填写名称' : '名称与其它适配器重复'}
        </p>
      )}

      <div className="flex flex-wrap items-end gap-3">{renderFields(item, onPatch)}</div>

      <div className="grid gap-3 border-t pt-3 sm:grid-cols-2">
        <SegmentedField
          label="消息格式"
          value={formatValue}
          options={ADAPTER_FORMAT_OPTIONS}
          onChange={(v) => onPatch({ messageFormat: v } as Partial<T>)}
        />
        <SegmentedField
          label="上报自身消息"
          value={reportValue}
          options={ADAPTER_REPORT_OPTIONS}
          onChange={(v) =>
            onPatch({
              reportSelfMessage: v === 'on',
            } as Partial<T>)
          }
        />
      </div>
    </motion.div>
  );
}

function updateNetworks<K extends NetworkKind>(
  config: OneBotConfig,
  update: (next: OneBotConfig) => void,
  kind: K,
  next: OneBotNetworks[K],
): void {
  update({
    ...config,
    networks: { ...config.networks, [kind]: next },
  });
}
