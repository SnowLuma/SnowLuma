import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GridStack, type GridStackWidget } from 'gridstack';
import { GripVertical, Settings2 } from 'lucide-react';
import 'gridstack/dist/gridstack.css';
import { GRID_CELL_HEIGHT, GRID_MARGIN, minSizeOf } from '@/lib/dashboard-layout';
import { cn } from '@/lib/utils';
import type { UiLayoutItem } from '@/types';

export interface GridCoord { id: string; x: number; y: number; w: number; h: number }

/** dataTransfer key carrying the dragged gallery widget id (HTML5 add). */
export const WIDGET_DRAG_TYPE = 'text/plain';

interface DashboardGridProps {
  /** Visible widgets only — each carries x/y/w/h. Hidden widgets live in the
   *  gallery, not the grid (Apple-widgets model: presence = shown). */
  blocks: UiLayoutItem[];
  editing: boolean;
  /** Column count — 12 on desktop, 1 on narrow screens (auto single-column). */
  cols: number;
  /**
   * Fired (debounced upstream) after a drag/resize/remove settles, with the
   * grid's current visible set. The consumer derives removal from absence: a
   * block that was visible but is no longer in `coords` was dragged out.
   */
  onChange: (coords: GridCoord[]) => void;
  renderWidget: (block: UiLayoutItem) => ReactNode;
  configurableIds: ReadonlySet<string>;
  onConfigOpen: (id: string) => void;
  /** CSS selector for the gallery drop-zone; dragging a card onto it removes
   *  the widget from the grid (gridstack `removable`). Edit mode only. */
  removableSelector?: string;
  /** Add a widget dropped from the gallery at the computed grid cell (HTML5
   *  drag-and-drop, driven entirely through React state). */
  onAdd?: (id: string, x: number, y: number) => void;
}

/**
 * gridstack-backed dashboard. gridstack owns the item shells (drag/resize/
 * position); React renders each widget's content into the item's content div
 * via a portal (React context still flows through portals). We re-init only
 * when the visible widget SET or the edit mode changes — never on a pure
 * coord change (gridstack already moved the item; the coord round-trips back
 * through `onChange` → state and matches what gridstack has).
 *
 * Add/remove are NOT done through gridstack's external drag-in: instead the
 * gallery drives React state (add = HTML5 drop here; remove = drag onto the
 * gallery via `removable`). Both funnel through the single `onChange` writer,
 * which reads the post-mutation grid snapshot — so there's no state race.
 */
export function DashboardGrid({
  blocks, editing, cols, onChange, renderWidget,
  configurableIds, onConfigOpen, removableSelector, onAdd,
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
        // Drag a card onto the gallery to remove it (edit mode only). The whole
        // card is the drag target; the corner icons are just hints.
        removable: editing && removableSelector ? removableSelector : false,
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
    // (unchanged) starting layout back to the server on mount. `change` covers
    // move/resize; `removed` covers a drag-to-gallery — both re-read the
    // snapshot, and the consumer treats any now-absent visible block as removed.
    const persist = () => {
      const saved = grid.save(false) as GridStackWidget[];
      onChangeRef.current(
        saved
          .filter((n): n is GridStackWidget & { id: string } => n.id != null)
          .map((n) => ({ id: String(n.id), x: n.x ?? 0, y: n.y ?? 0, w: n.w ?? 1, h: n.h ?? 1 })),
      );
    };
    grid.on('change', persist);
    grid.on('removed', persist);

    return () => {
      grid.off('change');
      grid.off('removed');
      grid.destroy(false); // tear down gridstack, keep the React-owned container
      host.replaceChildren();
      gridRef.current = null;
      setContentEls({});
    };
  }, [idKey, editing, cols, removableSelector]);

  // HTML5 drop from the gallery → add at the computed grid cell.
  const onDrop = (e: React.DragEvent) => {
    if (!editing || !onAdd) return;
    e.preventDefault();
    const id = e.dataTransfer.getData(WIDGET_DRAG_TYPE);
    const host = elRef.current;
    if (!id || !host) return;
    const rect = host.getBoundingClientRect();
    const colW = rect.width / cols || 1;
    const x = Math.max(0, Math.min(cols - 1, Math.floor((e.clientX - rect.left) / colW)));
    const y = Math.max(0, Math.floor((e.clientY - rect.top) / (GRID_CELL_HEIGHT + GRID_MARGIN)));
    onAdd(id, x, y);
  };

  return (
    <div
      ref={elRef}
      className="grid-stack -mx-1"
      onDragOver={(e) => { if (editing && onAdd) e.preventDefault(); }}
      onDrop={onDrop}
    >
      {blocks.map((b) => {
        const target = contentEls[b.id];
        if (!target) return null;
        return createPortal(
          <div className="relative h-full w-full">
            {editing && (
              <>
                {/* Subtle drag hint — a small square, not a bar. The whole card
                    is draggable; this just signals it (pointer-events-none so
                    the drag passes through to gridstack). */}
                <span
                  aria-hidden
                  title="拖动卡片调整位置 · 拖回右侧部件库可移除"
                  className="pointer-events-none absolute left-1.5 top-1.5 z-20 inline-flex size-6 items-center justify-center rounded-md bg-background/70 text-muted-foreground opacity-50 backdrop-blur-sm"
                >
                  <GripVertical className="size-3.5" />
                </span>
                {configurableIds.has(b.id) && (
                  <button
                    type="button"
                    onClick={() => onConfigOpen(b.id)}
                    title="设置"
                    aria-label="设置"
                    className="pointer-events-auto absolute right-1.5 top-1.5 z-20 inline-flex size-6 items-center justify-center rounded-md bg-background/70 text-muted-foreground opacity-60 backdrop-blur-sm transition-all outline-none hover:opacity-100 hover:text-foreground focus-visible:opacity-100 focus-visible:ring-[3px] focus-visible:ring-ring/40 cursor-pointer"
                  >
                    <Settings2 className="size-3.5" />
                  </button>
                )}
              </>
            )}
            <div className={cn('h-full w-full overflow-auto rounded-xl', editing && 'pointer-events-none select-none')}>
              {renderWidget(b)}
            </div>
          </div>,
          target,
        );
      })}
    </div>
  );
}
