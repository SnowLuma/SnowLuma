import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi } from '@/lib/api';
import { defaultOverviewGrid, migrateOverviewBlocks } from '@/lib/dashboard-layout';
import type { UiLayout, UiLayoutItem } from '@/types';

// Client-side layout customization (the "C" half). The server stores the
// layout in config/ui.json; this context loads it (authed `GET /api/ui`),
// hands it to the sidebar + overview, and persists edits via the section-merge
// `POST /api/ui {layout}` (so it never clobbers appearance).
//
// Reconciliation against the *known* catalogue is the CONSUMER's job
// (`reconcileLayoutItems`), so the context stays a dumb store and adding a new
// block / nav item later doesn't need a context change — it just appears.

const DEFAULT_NAV_ITEMS: UiLayoutItem[] = [
  { id: '/', visible: true },
  { id: '/processes', visible: true },
  { id: '/config', visible: true },
  { id: '/logs', visible: true },
  { id: '/settings', visible: true },
];

export const DEFAULT_LAYOUT: UiLayout = {
  // Overview blocks are the positioned grid widgets (the catalogue owns the
  // default placement + the legacy `stats`→tiles migration).
  overviewBlocks: defaultOverviewGrid(),
  navItems: DEFAULT_NAV_ITEMS.map((i) => ({ ...i })),
};

/**
 * Order + visibility for a known catalogue: keep stored items that still exist
 * (in their stored order + visibility), then append any catalogue entries the
 * stored layout predates (visible). `pinned` ids are forced visible.
 */
export function reconcileLayoutItems(
  stored: UiLayoutItem[] | undefined,
  known: readonly string[],
  pinned: readonly string[] = [],
): UiLayoutItem[] {
  const knownSet = new Set(known);
  const seen = new Set<string>();
  const out: UiLayoutItem[] = [];
  for (const item of stored ?? []) {
    if (!item || !knownSet.has(item.id) || seen.has(item.id)) continue;
    seen.add(item.id);
    out.push({ id: item.id, visible: pinned.includes(item.id) ? true : item.visible !== false });
  }
  for (const id of known) {
    if (!seen.has(id)) out.push({ id, visible: true });
  }
  return out;
}

interface LayoutContextValue {
  overviewBlocks: UiLayoutItem[];
  navItems: UiLayoutItem[];
  /** Persist a new overview-block order/visibility. */
  setOverviewBlocks: (items: UiLayoutItem[]) => void;
  /** Persist a new nav order/visibility. */
  setNavItems: (items: UiLayoutItem[]) => void;
  /** Reset both to defaults. */
  resetLayout: () => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [layout, setLayout] = useState<UiLayout>(DEFAULT_LAYOUT);
  const layoutRef = useRef(layout);
  // Set once the user edits, so the initial GET (which may resolve AFTER the
  // first edit) never clobbers their change.
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { layoutRef.current = layout; }, [layout]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api.ui.get();
        // Seed from the server only if the user hasn't already edited (the
        // overview + editor are interactive immediately, before this resolves).
        // Overview blocks are migrated to the current grid catalogue (legacy
        // `stats`→tiles, default coords for new/coordless widgets).
        if (!cancelled && !dirtyRef.current && config?.layout) {
          setLayout({
            overviewBlocks: migrateOverviewBlocks(config.layout.overviewBlocks),
            navItems: config.layout.navItems,
          });
        }
      } catch {
        /* keep defaults — layout is non-critical */
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // On unmount (e.g. logout), flush a pending debounced save so a last-moment
  // edit isn't lost; best-effort (a cleared token just 401s harmlessly).
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      void api.ui.save({ layout: layoutRef.current }).catch(() => { /* best-effort */ });
    }
  }, [api]);

  const persist = useCallback((next: UiLayout) => {
    dirtyRef.current = true;
    layoutRef.current = next;
    setLayout(next);
    if (saveTimer.current) clearTimeout(saveTimer.current);
    saveTimer.current = setTimeout(() => {
      saveTimer.current = null; // mark not-pending so the unmount flush can't double-fire
      void api.ui.save({ layout: next }).catch(() => { /* best-effort */ });
    }, 300);
  }, [api]);

  const setOverviewBlocks = useCallback((items: UiLayoutItem[]) => {
    persist({ ...layoutRef.current, overviewBlocks: items });
  }, [persist]);

  const setNavItems = useCallback((items: UiLayoutItem[]) => {
    persist({ ...layoutRef.current, navItems: items });
  }, [persist]);

  const resetLayout = useCallback(() => {
    persist({
      overviewBlocks: defaultOverviewGrid(),
      navItems: DEFAULT_NAV_ITEMS.map((i) => ({ ...i })),
    });
  }, [persist]);

  const value = useMemo<LayoutContextValue>(() => ({
    overviewBlocks: layout.overviewBlocks,
    navItems: layout.navItems,
    setOverviewBlocks,
    setNavItems,
    resetLayout,
  }), [layout, setOverviewBlocks, setNavItems, resetLayout]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
}
