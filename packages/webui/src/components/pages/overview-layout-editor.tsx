import { useMemo } from 'react';
import { Reorder } from 'motion/react';
import { Check, Eye, EyeOff, GripVertical, Lock, RotateCcw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { cn } from '@/lib/utils';
import type { UiLayoutItem } from '@/types';

// In-place layout editor for the overview page: two drag-to-reorder lists
// (overview cards + sidebar nav) with per-item show/hide. Uses motion's
// `Reorder` (zero new deps). Pinned items can be reordered but not hidden.
// Edits apply live through the LayoutContext setters (debounced-persisted), so
// "完成" just leaves edit mode.

interface ReorderListProps {
  items: UiLayoutItem[];
  labelFor: (id: string) => string;
  pinned?: readonly string[];
  onChange: (items: UiLayoutItem[]) => void;
}

function ReorderList({ items, labelFor, pinned = [], onChange }: ReorderListProps) {
  const ids = useMemo(() => items.map((i) => i.id), [items]);
  const byId = useMemo(() => new Map(items.map((i) => [i.id, i])), [items]);

  const reorder = (newIds: string[]) => {
    onChange(newIds.map((id) => byId.get(id)).filter((x): x is UiLayoutItem => !!x));
  };
  const toggle = (id: string) => {
    onChange(items.map((i) => (i.id === id ? { ...i, visible: !i.visible } : i)));
  };

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
  onBlocks: (items: UiLayoutItem[]) => void;
  onNav: (items: UiLayoutItem[]) => void;
  onReset: () => void;
  onDone: () => void;
}

export function LayoutEditor({
  blocks, blockLabelFor, navItems, navLabelFor, navPinned, onBlocks, onNav, onReset, onDone,
}: LayoutEditorProps) {
  return (
    <div className="flex flex-col gap-5">
      <div className="flex items-center justify-between gap-3">
        <div>
          <h2 className="text-lg font-semibold">编辑布局</h2>
          <p className="text-[11px] text-muted-foreground">拖动排序，点眼睛图标显示/隐藏。改动会自动保存。</p>
        </div>
        <div className="flex items-center gap-2">
          <Button variant="ghost" size="sm" onClick={onReset} className="text-muted-foreground">
            <RotateCcw className="size-4" /> 恢复默认
          </Button>
          <Button size="sm" onClick={onDone}>
            <Check className="size-4" /> 完成
          </Button>
        </div>
      </div>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">总览卡片</CardTitle>
          <CardDescription>调整总览页各卡片的顺序与显隐。</CardDescription>
        </CardHeader>
        <CardContent>
          <ReorderList items={blocks} labelFor={blockLabelFor} onChange={onBlocks} />
        </CardContent>
      </Card>

      <Card>
        <CardHeader>
          <CardTitle className="text-base">导航栏</CardTitle>
          <CardDescription>调整左侧导航的顺序与显隐（「系统设置」固定保留）。</CardDescription>
        </CardHeader>
        <CardContent>
          <ReorderList items={navItems} labelFor={navLabelFor} pinned={navPinned} onChange={onNav} />
        </CardContent>
      </Card>
    </div>
  );
}
