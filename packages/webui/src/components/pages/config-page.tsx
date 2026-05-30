// OneBot per-UIN configuration page.
//
// Layout: collapsible left sidebar for account selection + tabbed right
// pane (通用 / 4 network kinds). Each network tab is a list view of
// summary cards with inline enable/disable; create + edit both go
// through `NodeEditDialog`. The dirty-modify guard from the original
// hook is preserved end-to-end — switching accounts or kinds doesn't
// drop unsaved changes silently.

import { useMemo, useState } from 'react';
import { motion } from 'motion/react';
import { MousePointerClick, Plus, Save } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { Badge } from '@/components/ui/badge';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { cn } from '@/lib/utils';
import type {
  AdapterStatus,
  NetworkKind,
  OneBotConfig,
  OneBotNetworks,
} from '@/types';
import { useOneBotInstanceConfig } from '@/hooks/use-onebot-instance-config';
import { useAppState } from '@/contexts/AppStateContext';
import { AccountSidebar } from '@/components/config/account-sidebar';
import { GeneralSettingsTab } from '@/components/config/general-settings-tab';
import { NodeSummaryCard } from '@/components/config/node-summary-card';
import { NodeEditDialog } from '@/components/config/node-edit-dialog';
import {
  ALL_TABS,
  NETWORK_TABS,
  nextUniqueSuffix,
  type TabKey,
} from '@/components/config/defaults';

type DialogState =
  | { open: false }
  | { open: true; kind: NetworkKind; index: number | null; seed: OneBotNetworks[NetworkKind][number] };
//   index: null → create with `seed`, otherwise edit the item at that position.

export function ConfigPage() {
  const { qqList, connections, selectedUin, setSelectedUin } = useAppState();
  const {
    config,
    setConfig,
    dirty,
    requestSwitchUin,
    pendingSwitchUin,
    confirmSwitch,
    cancelSwitch,
    save,
    saveStatus,
  } = useOneBotInstanceConfig(qqList, {
    selectedUin,
    onSelectedUinChange: setSelectedUin,
  });

  const [activeTab, setActiveTab] = useState<TabKey>('general');
  // Default the account strip to its 56px avatar-only form on narrow screens
  // (≤lg) so the editor pane isn't squeezed; the user can still expand it.
  const [sidebarCollapsed, setSidebarCollapsed] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(max-width: 1024px)').matches,
  );
  const [confirmSave, setConfirmSave] = useState(false);
  // The edit dialog is modal and blocks every other click in the page,
  // so `selectedUin` cannot change while it's open — no defensive close
  // wiring needed beyond the dialog's own open/close.
  const [dialog, setDialog] = useState<DialogState>({ open: false });

  const pendingSwitchAccount = useMemo(
    () => (pendingSwitchUin ? qqList.find((q) => q.uin === pendingSwitchUin) ?? null : null),
    [pendingSwitchUin, qqList],
  );

  // Live adapter status for the selected account, keyed by adapter name so
  // each summary card can light up its real connection state.
  const liveStatusByName = useMemo(() => {
    const acc = connections.find((c) => c.uin === selectedUin);
    const map = new Map<string, AdapterStatus>();
    for (const a of acc?.adapters ?? []) map.set(a.name, a);
    return map;
  }, [connections, selectedUin]);

  // A discrete node mutation (create / edit / delete / enable-toggle) is
  // persisted the moment it happens — clicking 保存 inside the editor dialog
  // (or flipping the enable switch) IS the save. This removes the old
  // two-step trap where editing a token in the dialog only marked the config
  // "dirty" until you also pressed the top-right 保存, which silently cost
  // many users their token edits. The general-settings tab keeps its explicit
  // top-right save (it's a continuously-edited free-form surface).
  function commitKind<K extends NetworkKind>(kind: K, nextList: OneBotNetworks[K]): void {
    if (!config) return;
    const next = { ...config, networks: { ...config.networks, [kind]: nextList } };
    setConfig(next);
    void save(next);
  }

  function handleCreate<K extends NetworkKind>(kind: K, item: OneBotNetworks[K][number]): void {
    if (!config) return;
    const list = config.networks[kind] as OneBotNetworks[K];
    commitKind(kind, [...list, item] as OneBotNetworks[K]);
  }

  function handleEdit<K extends NetworkKind>(kind: K, index: number, item: OneBotNetworks[K][number]): void {
    if (!config) return;
    const list = config.networks[kind] as OneBotNetworks[K];
    commitKind(kind, list.map((it, i) => (i === index ? item : it)) as OneBotNetworks[K]);
  }

  function handleDelete<K extends NetworkKind>(kind: K, index: number): void {
    if (!config) return;
    const list = config.networks[kind] as OneBotNetworks[K];
    commitKind(kind, list.filter((_, i) => i !== index) as OneBotNetworks[K]);
  }

  function handleToggleEnabled<K extends NetworkKind>(kind: K, index: number, enabled: boolean): void {
    if (!config) return;
    const list = config.networks[kind] as OneBotNetworks[K];
    commitKind(
      kind,
      list.map((it, i) =>
        i === index ? ({ ...it, enabled: enabled ? undefined : false } as OneBotNetworks[K][number]) : it,
      ) as OneBotNetworks[K],
    );
  }

  const openCreate = (kind: NetworkKind) => {
    if (!config) return;
    const tab = NETWORK_TABS[kind];
    const list = config.networks[kind];
    const suffix = nextUniqueSuffix(list, tab.defaultEntry);
    setDialog({ open: true, kind, index: null, seed: tab.defaultEntry(suffix) });
  };

  const openEdit = (kind: NetworkKind, index: number) => {
    if (!config) return;
    const item = config.networks[kind][index];
    if (!item) return;
    setDialog({ open: true, kind, index, seed: item });
  };

  return (
    <div className="flex gap-4">
      <AccountSidebar
        accounts={qqList}
        selectedUin={selectedUin}
        onSelect={requestSwitchUin}
        collapsed={sidebarCollapsed}
        onToggleCollapsed={() => setSidebarCollapsed((v) => !v)}
      />

      <div className="min-w-0 flex-1">
        {!selectedUin ? (
          <EmptyState />
        ) : !config ? (
          <LoadingSkeleton />
        ) : (
          <div className="flex flex-col gap-4">
            <HeaderBar
              selectedUin={selectedUin}
              dirty={dirty}
              saveStatus={saveStatus}
              onSave={() => setConfirmSave(true)}
              activeTab={activeTab}
              onCreate={
                activeTab !== 'general' ? () => openCreate(activeTab as NetworkKind) : undefined
              }
            />

            <TabStrip
              activeTab={activeTab}
              onChange={setActiveTab}
              counts={countMap(config.networks)}
            />

            {activeTab === 'general' ? (
              <GeneralSettingsTab config={config} onChange={setConfig} />
            ) : (
              <NetworkTabView
                kind={activeTab}
                config={config}
                statusByName={liveStatusByName}
                onCreateClick={() => openCreate(activeTab)}
                onEdit={(idx) => openEdit(activeTab, idx)}
                onDelete={(idx) => handleDelete(activeTab, idx)}
                onToggleEnabled={(idx, v) => handleToggleEnabled(activeTab, idx, v)}
              />
            )}
          </div>
        )}
      </div>

      {/* Single dialog covers create + edit across all 4 kinds. */}
      {dialog.open && config && (
        <NodeEditDialog
          open={dialog.open}
          onOpenChange={(open) => !open && setDialog({ open: false })}
          kind={dialog.kind}
          initial={dialog.seed}
          isEdit={dialog.index != null}
          otherNames={otherNames(config.networks, dialog.kind, dialog.index)}
          onSubmit={(item) => {
            if (dialog.index == null) handleCreate(dialog.kind, item);
            else handleEdit(dialog.kind, dialog.index, item);
          }}
        />
      )}

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

// ─────────────── header ───────────────

interface HeaderBarProps {
  selectedUin: string;
  dirty: boolean;
  saveStatus: string;
  onSave: () => void;
  activeTab: TabKey;
  onCreate?: () => void;
}

function HeaderBar({ selectedUin, dirty, saveStatus, onSave, activeTab, onCreate }: HeaderBarProps) {
  return (
    <div className="flex flex-col gap-3 sm:flex-row sm:items-center sm:justify-between">
      <div className="min-w-0">
        <h2 className="text-base font-semibold tracking-tight">OneBot 协议端点</h2>
        <code className="mt-0.5 block font-mono text-xs text-muted-foreground tabular-nums">
          UIN {selectedUin}
        </code>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        {saveStatus && (
          <span
            className={cn(
              'rounded-full border px-2.5 py-1 text-[11px] font-medium',
              saveStatus === '保存成功' && 'border-success/30 bg-success/10 text-success',
              saveStatus === '保存中...' && 'border-border bg-muted text-muted-foreground',
              saveStatus !== '保存成功' &&
                saveStatus !== '保存中...' &&
                'border-destructive/30 bg-destructive/10 text-destructive',
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
        {onCreate && (
          <Button size="sm" variant="outline" onClick={onCreate}>
            <Plus className="size-3.5" />
            新建{activeTab === 'general' ? '' : NETWORK_TABS[activeTab as NetworkKind].title}
          </Button>
        )}
        <Button onClick={onSave} size="sm" disabled={!dirty}>
          <Save className="size-3.5" /> 保存
        </Button>
      </div>
    </div>
  );
}

// ─────────────── tab strip ───────────────

interface TabStripProps {
  activeTab: TabKey;
  onChange: (key: TabKey) => void;
  counts: Record<NetworkKind, number>;
}

function TabStrip({ activeTab, onChange, counts }: TabStripProps) {
  return (
    <div className="flex gap-1 overflow-x-auto border-b [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
      {ALL_TABS.map((key) => {
        const label = key === 'general' ? '通用设置' : NETWORK_TABS[key].title;
        const count = key === 'general' ? null : counts[key];
        const active = activeTab === key;
        return (
          <button
            key={key}
            type="button"
            onClick={() => onChange(key)}
            className={cn(
              'group relative inline-flex shrink-0 items-center gap-1.5 whitespace-nowrap px-3 py-2 text-sm transition-colors cursor-pointer',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {label}
            {count != null && (
              <Badge
                variant={active ? 'default' : 'secondary'}
                className="h-4 px-1.5 font-mono text-[10px] tabular-nums"
              >
                {count}
              </Badge>
            )}
            {active && (
              <motion.span
                layoutId="config-tab-underline"
                className="absolute inset-x-2 -bottom-px h-0.5 rounded-full bg-primary"
                transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              />
            )}
          </button>
        );
      })}
    </div>
  );
}

function countMap(networks: OneBotNetworks): Record<NetworkKind, number> {
  return {
    httpServers: networks.httpServers.length,
    httpClients: networks.httpClients.length,
    wsServers: networks.wsServers.length,
    wsClients: networks.wsClients.length,
  };
}

// ─────────────── network tab body ───────────────

interface NetworkTabViewProps {
  kind: NetworkKind;
  config: OneBotConfig;
  statusByName: Map<string, AdapterStatus>;
  onCreateClick: () => void;
  onEdit: (index: number) => void;
  onDelete: (index: number) => void;
  onToggleEnabled: (index: number, enabled: boolean) => void;
}

function NetworkTabView({
  kind,
  config,
  statusByName,
  onCreateClick,
  onEdit,
  onDelete,
  onToggleEnabled,
}: NetworkTabViewProps) {
  const tab = NETWORK_TABS[kind];
  const list = config.networks[kind];
  // `summarize` is typed per K in NETWORK_TABS; the union here forces a
  // widening cast at the call site rather than ladder-of-ifs per tab.
  const summarize = tab.summarize as (it: typeof list[number]) => string;

  // Tally name occurrences once instead of doing `list.filter(...).map(...).includes(...)`
  // inside `.map()` (O(n²) per render). With this lookup, the duplicate
  // check is O(1) per row — matters once the list grows past a few entries
  // or when typing renames a node and the tab re-renders on every keystroke.
  const nameCounts = useMemo(() => {
    const counts = new Map<string, number>();
    for (const item of list) {
      const name = item.name;
      if (!name) continue;
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
    return counts;
  }, [list]);

  if (list.length === 0) {
    return (
      <div className="flex flex-col items-center justify-center gap-3 rounded-lg border border-dashed py-16 text-muted-foreground">
        <p className="text-sm">暂无 {tab.title} 节点</p>
        <Button variant="outline" size="sm" onClick={onCreateClick}>
          <Plus className="size-3.5" /> 创建第一个
        </Button>
      </div>
    );
  }

  return (
    <div className="flex flex-col gap-2">
      <p className="text-xs text-muted-foreground">{tab.description}</p>
      <div className="flex flex-col gap-2">
        {list.map((item, idx) => {
          const duplicate = !!item.name && (nameCounts.get(item.name) ?? 0) > 1;
          return (
            <NodeSummaryCard
              key={`${item.name}-${idx}`}
              item={item}
              summary={summarize(item)}
              duplicateName={duplicate}
              liveStatus={statusByName.get(item.name)}
              onToggleEnabled={(v) => onToggleEnabled(idx, v)}
              onEdit={() => onEdit(idx)}
              onDelete={() => onDelete(idx)}
            />
          );
        })}
      </div>
    </div>
  );
}

// ─────────────── empty + loading ───────────────

function EmptyState() {
  return (
    <div className="flex h-64 flex-col items-center justify-center gap-2 rounded-lg border border-dashed text-muted-foreground">
      <MousePointerClick className="size-7" strokeWidth={1.5} />
      <p className="text-sm">请在左栏选择会话以配置通信节点</p>
    </div>
  );
}

function LoadingSkeleton() {
  return (
    <div className="space-y-3">
      <Skeleton className="h-9 w-48" />
      <Skeleton className="h-10" />
      <Skeleton className="h-20" />
      <Skeleton className="h-20" />
    </div>
  );
}

// ─────────────── helpers ───────────────

/** Names of every adapter except the one currently being edited. */
function otherNames<K extends NetworkKind>(
  networks: OneBotNetworks,
  kind: K,
  excludeIndex: number | null,
): string[] {
  const list = networks[kind];
  return list
    .filter((_, i) => i !== excludeIndex)
    .map((n) => n.name)
    .filter((s): s is string => typeof s === 'string' && s.length > 0);
}
