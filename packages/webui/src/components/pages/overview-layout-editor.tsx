import { useMemo } from 'react';
import { Reorder } from 'motion/react';
import { Check, Eye, EyeOff, GripVertical, Lock, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { UiLayoutItem } from '@/types';

// Edit panel for the overview's "编辑布局" mode. Overview-card POSITION/SIZE is
// edited in place on the gridstack grid below; this panel only toggles which
// cards are shown, and (re)orders the sidebar nav (a 1-D list, so it keeps the
// motion Reorder drag from phase 3). Pinned nav items can't be hidden.

// ── widget visibility (no drag — grid owns position) ──

function VisibilityList({
  items, labelFor, onToggle,
}: { items: UiLayoutItem[]; labelFor: (id: string) => string; onToggle: (id: string) => void }) {
  return (
    <div className="flex flex-col gap-2">
      {items.map((item) => (
        <div
          key={item.id}
          className={cn(
            'flex items-center gap-3 rounded-lg border bg-card/50 px-3 py-2.5',
            !item.visible && 'opacity-50',
          )}
        >
          <span className="flex-1 truncate text-sm font-medium">{labelFor(item.id)}</span>
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
      ))}
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
  onNav: (items: UiLayoutItem[]) => void;
  onReset: () => void;
  onDone: () => void;
}

export function LayoutEditor({
  blocks, blockLabelFor, navItems, navLabelFor, navPinned, onToggleBlock, onNav, onReset, onDone,
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
          <p className="text-xs font-medium text-muted-foreground">总览卡片（显隐）</p>
          <VisibilityList items={blocks} labelFor={blockLabelFor} onToggle={onToggleBlock} />
        </div>
        <div className="flex flex-col gap-2">
          <p className="text-xs font-medium text-muted-foreground">导航栏（拖动排序）</p>
          <NavReorderList items={navItems} labelFor={navLabelFor} pinned={navPinned} onChange={onNav} />
        </div>
      </CardContent>
    </Card>
  );
}
