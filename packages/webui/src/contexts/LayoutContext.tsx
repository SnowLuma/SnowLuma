import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { useApi } from '@/lib/api';
import { defaultOverviewGrid, defaultOverviewMobile, migrateOverviewBlocks } from '@/lib/dashboard-layout';
import type { UiLayout, UiLayoutItem, UiPages } from '@/types';

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

// Toggleable top-bar elements (essential ones are pinned in the consumer). The
// catalogue (labels) lives with the top-bar; this is just the default order.
export const TOPBAR_ITEM_IDS = ['status', 'theme', 'kiosk'] as const;
const DEFAULT_TOPBAR_ITEMS: UiLayoutItem[] = TOPBAR_ITEM_IDS.map((id) => ({ id, visible: true }));

export const DEFAULT_LAYOUT: UiLayout = {
  // Overview blocks are the positioned grid widgets (the catalogue owns the
  // default placement + the legacy `stats`→tiles migration).
  overviewBlocks: defaultOverviewGrid(),
  overviewMobile: defaultOverviewMobile(),
  navItems: DEFAULT_NAV_ITEMS.map((i) => ({ ...i })),
  topbarItems: DEFAULT_TOPBAR_ITEMS.map((i) => ({ ...i })),
};

const ALL_LEVELS = ['trace', 'debug', 'info', 'success', 'warn', 'error'];

export function defaultPages(): UiPages {
  return {
    defaultRoute: '/',
    logs: { visibleLevels: [...ALL_LEVELS], maxLines: 1000, autoScroll: true, wrap: true, highlightRules: [], preset: 'custom' },
    processesSort: 'pid',
    configTab: '',
  };
}

export const DEFAULT_PAGES: UiPages = defaultPages();

/**
 * Order + visibility for a known catalogue: keep stored items that still exist
 * (in their stored order + visibility), then append any catalogue entries the
 * stored layout predates. `pinned` ids are forced visible; ids in
 * `hiddenByDefault` are appended hidden (opt-in widgets), otherwise visible.
 */
export function reconcileLayoutItems(
  stored: UiLayoutItem[] | undefined,
  known: readonly string[],
  pinned: readonly string[] = [],
  hiddenByDefault: ReadonlySet<string> = new Set(),
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
    if (!seen.has(id)) out.push({ id, visible: !hiddenByDefault.has(id) });
  }
  return out;
}

interface LayoutContextValue {
  overviewBlocks: UiLayoutItem[];
  overviewMobile: UiLayoutItem[];
  navItems: UiLayoutItem[];
  topbarItems: UiLayoutItem[];
  /** Persist a new overview-block order/visibility (desktop 2D grid). */
  setOverviewBlocks: (items: UiLayoutItem[]) => void;
  /** Persist a new single-column mobile order/visibility. */
  setOverviewMobile: (items: UiLayoutItem[]) => void;
  /** Persist a new nav order/visibility. */
  setNavItems: (items: UiLayoutItem[]) => void;
  /** Persist a new top-bar show/hide order. */
  setTopbarItems: (items: UiLayoutItem[]) => void;
  /** Reset layout (blocks + mobile + nav + topbar) to defaults. */
  resetLayout: () => void;
  /** Per-page preferences (default route, logs/processes/config prefs). */
  pages: UiPages;
  /** Merge a partial pages-prefs update (debounced-persisted). */
  setPages: (patch: Partial<UiPages>) => void;
  /** True once the authed config load has resolved (gates the default-route redirect). */
  ready: boolean;
  /** Shared "编辑布局" mode — the dashboard grid AND the sidebar read this so both
   *  show in-place edit affordances from a single toggle. */
  editing: boolean;
  setEditing: (v: boolean) => void;
}

const LayoutContext = createContext<LayoutContextValue | null>(null);

export function LayoutProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const [layout, setLayout] = useState<UiLayout>(DEFAULT_LAYOUT);
  const [pages, setPagesState] = useState<UiPages>(DEFAULT_PAGES);
  const [ready, setReady] = useState(false);
  const [editing, setEditing] = useState(false);
  const layoutRef = useRef(layout);
  const pagesRef = useRef(pages);
  // Set once the user edits, so the initial GET (which may resolve AFTER the
  // first edit) never clobbers their change.
  const dirtyRef = useRef(false);
  const saveTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const pagesTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => { layoutRef.current = layout; }, [layout]);
  useEffect(() => { pagesRef.current = pages; }, [pages]);

  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const config = await api.ui.get();
        // Seed from the server only if the user hasn't already edited (the
        // overview + editor are interactive immediately, before this resolves).
        // Overview blocks are migrated to the current grid catalogue (legacy
        // `stats`→tiles, default coords for new/coordless widgets).
        if (!cancelled && !dirtyRef.current && config) {
          if (config.layout) {
            setLayout({
              overviewBlocks: migrateOverviewBlocks(config.layout.overviewBlocks),
              // Mobile/topbar are stored raw; consumers reconcile against their
              // known catalogues (so a new widget/element "just appears").
              overviewMobile: config.layout.overviewMobile ?? defaultOverviewMobile(),
              navItems: config.layout.navItems,
              topbarItems: config.layout.topbarItems ?? DEFAULT_TOPBAR_ITEMS.map((i) => ({ ...i })),
            });
          }
          if (config.pages) setPagesState(config.pages);
        }
      } catch {
        /* keep defaults — layout/pages are non-critical */
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => { cancelled = true; };
  }, [api]);

  // On unmount (e.g. logout), flush pending debounced saves so a last-moment
  // edit isn't lost; best-effort (a cleared token just 401s harmlessly).
  useEffect(() => () => {
    if (saveTimer.current) {
      clearTimeout(saveTimer.current);
      void api.ui.save({ layout: layoutRef.current }).catch(() => { /* best-effort */ });
    }
    if (pagesTimer.current) {
      clearTimeout(pagesTimer.current);
      void api.ui.save({ pages: pagesRef.current }).catch(() => { /* best-effort */ });
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

  const setOverviewMobile = useCallback((items: UiLayoutItem[]) => {
    persist({ ...layoutRef.current, overviewMobile: items });
  }, [persist]);

  const setNavItems = useCallback((items: UiLayoutItem[]) => {
    persist({ ...layoutRef.current, navItems: items });
  }, [persist]);

  const setTopbarItems = useCallback((items: UiLayoutItem[]) => {
    persist({ ...layoutRef.current, topbarItems: items });
  }, [persist]);

  const resetLayout = useCallback(() => {
    persist({
      overviewBlocks: defaultOverviewGrid(),
      overviewMobile: defaultOverviewMobile(),
      navItems: DEFAULT_NAV_ITEMS.map((i) => ({ ...i })),
      topbarItems: DEFAULT_TOPBAR_ITEMS.map((i) => ({ ...i })),
    });
  }, [persist]);

  const setPages = useCallback((patch: Partial<UiPages>) => {
    dirtyRef.current = true;
    const next = { ...pagesRef.current, ...patch };
    pagesRef.current = next;
    setPagesState(next);
    if (pagesTimer.current) clearTimeout(pagesTimer.current);
    pagesTimer.current = setTimeout(() => {
      pagesTimer.current = null;
      void api.ui.save({ pages: next }).catch(() => { /* best-effort */ });
    }, 300);
  }, [api]);

  const value = useMemo<LayoutContextValue>(() => ({
    overviewBlocks: layout.overviewBlocks,
    overviewMobile: layout.overviewMobile,
    navItems: layout.navItems,
    topbarItems: layout.topbarItems,
    setOverviewBlocks,
    setOverviewMobile,
    setNavItems,
    setTopbarItems,
    resetLayout,
    pages,
    setPages,
    ready,
    editing,
    setEditing,
  }), [layout, setOverviewBlocks, setOverviewMobile, setNavItems, setTopbarItems, resetLayout, pages, setPages, ready, editing]);

  return <LayoutContext.Provider value={value}>{children}</LayoutContext.Provider>;
}

export function useLayout(): LayoutContextValue {
  const ctx = useContext(LayoutContext);
  if (!ctx) throw new Error('useLayout must be used within LayoutProvider');
  return ctx;
}
