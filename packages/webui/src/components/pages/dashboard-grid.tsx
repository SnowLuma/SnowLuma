import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GridStack, type GridStackWidget } from 'gridstack';
import { Eye, EyeOff, GripVertical, Settings2 } from 'lucide-react';
import 'gridstack/dist/gridstack.css';
import { GRID_CELL_HEIGHT, GRID_MARGIN, minSizeOf } from '@/lib/dashboard-layout';
import { cn } from '@/lib/utils';
import type { UiLayoutItem } from '@/types';

export interface GridCoord { id: string; x: number; y: number; w: number; h: number }

interface DashboardGridProps {
  /** Blocks to render — visible-only in view mode, ALL (incl. hidden) in edit
   *  mode so hidden widgets show as re-enableable ghosts. Each has x/y/w/h. */
  blocks: UiLayoutItem[];
  editing: boolean;
  /** Column count — 12 on desktop, 1 on narrow screens (auto single-column). */
  cols: number;
  /** Fired (debounced upstream) after a drag/resize settles. */
  onChange: (coords: GridCoord[]) => void;
  renderWidget: (block: UiLayoutItem) => ReactNode;
  // ── edit overlay ──
  labelFor: (id: string) => string;
  configurableIds: ReadonlySet<string>;
  onToggleVisible: (id: string) => void;
  onConfigOpen: (id: string) => void;
}

/**
 * gridstack-backed dashboard. gridstack owns the item shells (drag/resize/
 * position); React renders each widget's content into the item's content div
 * via a portal (React context still flows through portals). We re-init only
 * when the visible widget SET or the edit mode changes — never on a pure
 * coord change (gridstack already moved the item; the coord round-trips back
 * through `onChange` → state and matches what gridstack has).
 */
export function DashboardGrid({
  blocks, editing, cols, onChange, renderWidget,
  labelFor, configurableIds, onToggleVisible, onConfigOpen,
}: DashboardGridProps) {
  const elRef = useRef<HTMLDivElement | null>(null);
  const gridRef = useRef<GridStack | null>(null);
  const [contentEls, setContentEls] = useState<Record<string, HTMLElement>>({});

  // Latest props mirrored into refs so the init effect (keyed only on the
  // id-set + editing) reads current values without re-running on every render.
  const blocksRef = useRef(blocks);
  const onChangeRef = useRef(onChange);
  useLayoutEffect(() => { blocksRef.current = blocks; onChangeRef.current = onChange; });

  // Re-init when the visible widget set or the edit mode changes.
  const idKey = blocks.map((b) => b.id).join('|');

  useLayoutEffect(() => {
    const host = elRef.current;
    if (!host) return;

    const grid = GridStack.init(
      {
        column: cols,
        cellHeight: GRID_CELL_HEIGHT,
        margin: GRID_MARGIN,
        float: true, // free placement — items stay where dropped (no auto-compact)
        disableDrag: !editing,
        disableResize: !editing,
        // Default handle (.grid-stack-item-content) = the whole card is a drag
        // target in edit mode — forgiving + discoverable. The card body is
        // pointer-events-none in edit mode so widget controls don't fire, and
        // the eye/gear are <button>s which gridstack's skipMouseDown excludes
        // from dragging. The overlay's grip + "拖动" label is the visual cue.
      },
      host,
    );
    gridRef.current = grid;

    const els: Record<string, HTMLElement> = {};
    grid.batchUpdate();
    for (const b of blocksRef.current) {
      const { minW, minH } = minSizeOf(b.id);
      const itemEl = grid.addWidget({ id: b.id, x: b.x, y: b.y, w: b.w, h: b.h, minW, minH });
      const content = itemEl.querySelector('.grid-stack-item-content') as HTMLElement | null;
      if (content) els[b.id] = content;
    }
    grid.batchUpdate(false);
    setContentEls(els);

    // Attach AFTER the initial programmatic build so we don't persist the
    // (unchanged) starting layout back to the server on mount.
    const persist = () => {
      const saved = grid.save(false) as GridStackWidget[];
      onChangeRef.current(
        saved
          .filter((n): n is GridStackWidget & { id: string } => n.id != null)
          .map((n) => ({ id: String(n.id), x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 1, h: n.h ?? 1 })),
      );
    };
    grid.on('change', persist);

    return () => {
      grid.off('change');
      grid.destroy(false); // tear down gridstack, keep the React-owned container
      // Remove the item DOM gridstack created (React never owned these).
      host.replaceChildren();
      gridRef.current = null;
      setContentEls({});
    };
  }, [idKey, editing, cols]);

  return (
    <div ref={elRef} className="grid-stack -mx-1">
      {blocks.map((b) => {
        const target = contentEls[b.id];
        if (!target) return null;
        const hidden = editing && !b.visible;
        return createPortal(
          <div className="relative h-full w-full">
            {editing && (
              <div className="pointer-events-auto absolute inset-x-0 top-0 z-20 flex items-center gap-1 rounded-t-xl border-b border-border/50 bg-background/70 px-1.5 py-1 backdrop-blur-sm">
                <div
                  className="widget-drag-handle flex flex-1 cursor-grab items-center gap-1 rounded px-1 py-0.5 text-[11px] font-medium text-muted-foreground hover:bg-accent/50 active:cursor-grabbing"
                  title="拖动调整位置"
                >
                  <GripVertical className="size-3.5" /> 拖动
                </div>
                {configurableIds.has(b.id) && b.visible && (
                  <button
                    type="button"
                    onClick={() => onConfigOpen(b.id)}
                    title="设置"
                    aria-label="设置"
                    className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                  >
                    <Settings2 className="size-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => onToggleVisible(b.id)}
                  title={b.visible ? '隐藏' : '显示'}
                  aria-label={b.visible ? '隐藏' : '显示'}
                  className="inline-flex size-6 cursor-pointer items-center justify-center rounded text-muted-foreground transition-colors hover:bg-accent/50 hover:text-foreground"
                >
                  {b.visible ? <Eye className="size-3.5" /> : <EyeOff className="size-3.5" />}
                </button>
              </div>
            )}
            {hidden ? (
              <div className="flex h-full w-full items-center justify-center rounded-xl border border-dashed bg-muted/20 px-2 text-center text-[11px] text-muted-foreground">
                {labelFor(b.id)} · 已隐藏
              </div>
            ) : (
              <div className={cn('h-full w-full overflow-auto rounded-xl', editing && 'pointer-events-none select-none')}>
                {renderWidget(b)}
              </div>
            )}
          </div>,
          target,
        );
      })}
    </div>
  );
}
