import { useMemo, useState } from 'react';
import { Reorder } from 'motion/react';
import { Check, Eye, EyeOff, GripVertical, Lock, RotateCcw, Settings2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { cn } from '@/lib/utils';
import {
  ALL_LOG_LEVELS, CONFIGURABLE_WIDGETS, parseAlertsConfig, parseSessionsConfig,
} from '@/lib/dashboard-layout';
import type { UiLayoutItem } from '@/types';

type SortOpt = 'recent' | 'uin' | 'nickname';
const SORT_LABELS: Record<SortOpt, string> = { recent: '最近', uin: 'QQ 号', nickname: '昵称' };

// Edit panel for the overview's "编辑布局" mode. Overview-card POSITION/SIZE is
// edited in place on the gridstack grid below; this panel only toggles which
// cards are shown, and (re)orders the sidebar nav (a 1-D list, so it keeps the
// motion Reorder drag from phase 3). Pinned nav items can't be hidden.

// ── widget visibility (no drag — grid owns position) ──

function AlertsConfigForm({ config, onChange }: { config: Record<string, unknown> | undefined; onChange: (c: Record<string, unknown>) => void }) {
  const c = parseAlertsConfig(config);
  return (
    <div className="flex flex-col gap-3 border-t bg-muted/20 px-3 py-3">
      <label className="flex items-center justify-between gap-3 text-xs">
        <span className="text-muted-foreground">显示条数</span>
        <Input
          type="number" min={1} max={50} value={c.count}
          onChange={(e) => onChange({ count: Math.min(50, Math.max(1, Math.trunc(Number(e.target.value) || 1))) })}
          className="h-8 w-20"
        />
      </label>
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">级别</span>
        <div className="flex flex-wrap gap-1.5">
          {ALL_LOG_LEVELS.map((lv) => {
            const on = c.levels.includes(lv);
            return (
              <button
                key={lv}
                type="button"
                onClick={() => {
                  const next = on ? c.levels.filter((x) => x !== lv) : [...c.levels, lv];
                  if (next.length > 0) onChange({ levels: next });
                }}
                className={cn(
                  'rounded-md border px-2 py-1 text-[11px] uppercase transition-colors cursor-pointer',
                  on ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/40',
                )}
              >
                {lv}
              </button>
            );
          })}
        </div>
      </div>
    </div>
  );
}

function SessionsConfigForm({ config, onChange }: { config: Record<string, unknown> | undefined; onChange: (c: Record<string, unknown>) => void }) {
  const c = parseSessionsConfig(config);
  return (
    <div className="flex flex-col gap-3 border-t bg-muted/20 px-3 py-3">
      <div className="flex flex-col gap-1.5">
        <span className="text-xs text-muted-foreground">排序</span>
        <div className="flex flex-wrap gap-1.5">
          {(['recent', 'uin', 'nickname'] as SortOpt[]).map((s) => (
            <button
              key={s}
              type="button"
              onClick={() => onChange({ sort: s })}
              className={cn(
                'rounded-md border px-2 py-1 text-[11px] transition-colors cursor-pointer',
                c.sort === s ? 'border-primary bg-primary/10 text-primary' : 'border-border text-muted-foreground hover:bg-accent/40',
              )}
            >
              {SORT_LABELS[s]}
            </button>
          ))}
        </div>
      </div>
      <label className="flex flex-col gap-1.5 text-xs">
        <span className="text-muted-foreground">筛选（昵称 / QQ 号）</span>
        <Input value={c.filter} placeholder="留空显示全部" maxLength={100} onChange={(e) => onChange({ filter: e.target.value })} className="h-8" />
      </label>
    </div>
  );
}

function VisibilityList({
  items, labelFor, onToggle, onConfig,
}: {
  items: UiLayoutItem[];
  labelFor: (id: string) => string;
  onToggle: (id: string) => void;
  onConfig: (id: string, config: Record<string, unknown>) => void;
}) {
  const [open, setOpen] = useState<string | null>(null);
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => {
        const configurable = CONFIGURABLE_WIDGETS.has(item.id);
        const isOpen = open === item.id;
        return (
          <div key={item.id} className={cn('overflow-hidden rounded-lg border bg-card/50', !item.visible && 'opacity-50')}>
            <div className="flex items-center gap-3 px-3 py-2.5">
              <span className="flex-1 truncate text-sm font-medium">{labelFor(item.id)}</span>
              {configurable && (
                <button
                  type="button"
                  onClick={() => setOpen(isOpen ? null : item.id)}
                  title="设置"
                  aria-label="设置"
                  className={cn(
                    'inline-flex size-8 cursor-pointer items-center justify-center rounded-md transition-colors hover:bg-accent/40',
                    isOpen ? 'text-primary' : 'text-muted-foreground hover:text-foreground',
                  )}
                >
                  <Settings2 className="size-4" />
                </button>
              )}
              <button
                type="button"
                onClick={() => onToggle(item.id)}
                title={item.visible ? '隐藏' : '显示'}
                aria-label={item.visible ? '隐藏' : '显示'}
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                {item.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              </button>
            </div>
            {configurable && isOpen && (
              item.id === 'alerts'
                ? <AlertsConfigForm config={item.config} onChange={(c) => onConfig('alerts', c)} />
                : <SessionsConfigForm config={item.config} onChange={(c) => onConfig('sessions', c)} />
            )}
          </div>
        );
      })}
    </div>
  );
}

// ── nav reorder + visibility (1-D list, motion drag) ──

function NavReorderList({
  items, labelFor, pinned, onChange,
}: { items: UiLayoutItem[]; labelFor: (id: string) => string; pinned: readonly string[]; onChange: (items: UiLayoutItem[]) => void }) {
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const reorder = (newIds: string[]) =>
    onChange(newIds.map((id) => byId.get(id)).filter((x): x is UiLayoutItem => !!x));
  const toggle = (id: string) =>
    onChange(items.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)));

  return (
    <Reorder.Group axis="y" values={ids} onReorder={reorder} className="flex flex-col gap-2">
      {ids.map((id) => {
        const item = byId.get(id);
        if (!item) return null;
        const isPinned = pinned.includes(id);
        return (
          <Reorder.Item
            key={id}
            value={id}
            className={cn(
              'flex items-center gap-3 rounded-lg border bg-card/50 px-3 py-2.5 select-none',
              'cursor-grab active:cursor-grabbing',
              !item.visible && 'opacity-50',
            )}
          >
            <GripVertical className="size-4 shrink-0 text-muted-foreground" />
            <span className="flex-1 truncate text-sm font-medium">{labelFor(id)}</span>
            {isPinned ? (
              <span title="必选项，不可隐藏" className="inline-flex size-8 items-center justify-center text-muted-foreground/60">
                <Lock className="size-4" />
              </span>
            ) : (
              <button
                type="button"
                onClick={() => toggle(id)}
                title={item.visible ? '隐藏' : '显示'}
                aria-label={item.visible ? '隐藏' : '显示'}
                className="inline-flex size-8 cursor-pointer items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent/40 hover:text-foreground"
              >
                {item.visible ? <Eye className="size-4" /> : <EyeOff className="size-4" />}
              </button>
            )}
          </Reorder.Item>
        );
      })}
    </Reorder.Group>
  );
}

export interface LayoutEditorProps {
  blocks: UiLayoutItem[];
  blockLabelFor: (id: string) => string;
  navItems: UiLayoutItem[];
  navLabelFor: (id: string) => string;
  navPinned: readonly string[];
  onToggleBlock: (id: string) => void;
  onBlockConfig: (id: string, config: Record<string, unknown>) => void;
  onNav: (items: UiLayoutItem[]) => void;
  onReset: () => void;
  onDone: () => void;
}

export function LayoutEditor({
  blocks, blockLabelFor, navItems, navLabelFor, navPinned, onToggleBlock, onBlockConfig, onNav, onReset, onDone,
}: LayoutEditorProps) {
  return (
    <Card>
      <CardHeader className="flex flex-row items-start justify-between gap-3 space-y-0">
        <div>
          <CardTitle className="text-base">编辑布局</CardTitle>
          <CardDescription>在下方网格直接拖动卡片、拖角缩放；这里控制卡片显隐与导航。改动自动保存。</CardDescription>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReset} className="text-muted-foreground">
            <RotateCcw className="size-4" /> 恢复默认
          </Button>
          <Button size="sm" onClick={onDone}>
            <Check className="size-4" /> 完成
          </Button>
        </div>
      </CardHeader>
      <CardContent className="grid gap-6 md:grid-cols-2">
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">总览卡片（显隐 / 设置）</p>
          <VisibilityList items={blocks} labelFor={blockLabelFor} onToggle={onToggleBlock} onConfig={onBlockConfig} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">导航栏（拖动排序）</p>
          <NavReorderList items={navItems} labelFor={navLabelFor} pinned={navPinned} onChange={onNav} />
        </div>
      </CardContent>
    </Card>
  );
}
