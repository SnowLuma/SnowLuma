import { useLayoutEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import { GridStack, type GridStackWidget } from 'gridstack';
import 'gridstack/dist/gridstack.css';
import { GRID_CELL_HEIGHT, GRID_MARGIN, minSizeOf } from '@/lib/dashboard-layout';
import { cn } from '@/lib/utils';
import type { UiLayoutItem } from '@/types';

export interface GridCoord { id: string; x: number; y: number; w: number; h: number }

interface DashboardGridProps {
  /** Visible blocks, each with x/y/w/h (already migrated/positioned). */
  blocks: UiLayoutItem[];
  editing: boolean;
  /** Column count — 12 on desktop, 1 on narrow screens (auto single-column). */
  cols: number;
  /** Fired (debounced upstream) after a drag/resize settles. */
  onChange: (coords: GridCoord[]) => void;
  renderWidget: (block: UiLayoutItem) => ReactNode;
}

/**
 * gridstack-backed dashboard. gridstack owns the item shells (drag/resize/
 * position); React renders each widget's content into the item's content div
 * via a portal (React context still flows through portals). We re-init only
 * when the visible widget SET or the edit mode changes — never on a pure
 * coord change (gridstack already moved the item; the coord round-trips back
 * through `onChange` → state and matches what gridstack has).
 */
export function DashboardGrid({ blocks, editing, cols, onChange, renderWidget }: DashboardGridProps) {
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
        handle: '.grid-stack-item-content',
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
      {blocks.map((b) =>
        contentEls[b.id]
          ? createPortal(
            <div className={cn('h-full w-full overflow-auto', editing && 'pointer-events-none select-none')}>
              {renderWidget(b)}
            </div>,
            contentEls[b.id],
          )
          : null,
      )}
    </div>
  );
}
