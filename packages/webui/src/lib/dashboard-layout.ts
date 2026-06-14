import type { LogLevel, UiLayoutItem } from '@/types';

// The overview dashboard is a free 12-column gridstack grid. This module is
// the pure (React-free) catalogue + migration so it can be shared by the
// LayoutContext (defaults / reset / migrate-on-load), the DashboardGrid
// (render + min sizes), and the layout editor (labels) without import cycles.

export const GRID_COLS = 12;
/** px per grid row. Tiles are 1 row; cards a few rows. Sized so a 1-row stat
 *  tile's icon + 3 text lines (label + text-lg value + subtext) clear the
 *  py-3.5 padding with breathing room: item content ≈ cellHeight − 2·margin −
 *  card border ≈ 90px > the ~86px the content needs. */
export const GRID_CELL_HEIGHT = 108;
export const GRID_MARGIN = 8;

export interface GridWidgetSpec {
  id: string;
  label: string;
  /** Minimum width/height in grid units — prevents the content from collapsing. */
  minW: number;
  minH: number;
  /** Default placement when the operator hasn't positioned it yet. */
  def: { x: number; y: number; w: number; h: number };
}

/** The five top stat tiles, split out of the legacy single `stats` block. */
export const STAT_TILE_IDS = [
  'stat:status', 'stat:accounts', 'stat:processes', 'stat:host', 'stat:uptime',
] as const;

export const GRID_WIDGETS: GridWidgetSpec[] = [
  { id: 'stat:status', label: '服务状态', minW: 2, minH: 1, def: { x: 0, y: 0, w: 2, h: 1 } },
  { id: 'stat:accounts', label: '在线账号', minW: 2, minH: 1, def: { x: 2, y: 0, w: 2, h: 1 } },
  { id: 'stat:processes', label: '进程注入', minW: 2, minH: 1, def: { x: 4, y: 0, w: 2, h: 1 } },
  { id: 'stat:host', label: '主机名', minW: 2, minH: 1, def: { x: 6, y: 0, w: 2, h: 1 } },
  { id: 'stat:uptime', label: '系统运行', minW: 2, minH: 1, def: { x: 8, y: 0, w: 2, h: 1 } },
  { id: 'connections', label: 'OneBot 连接', minW: 3, minH: 3, def: { x: 0, y: 1, w: 6, h: 4 } },
  { id: 'alerts', label: '最近告警', minW: 3, minH: 3, def: { x: 6, y: 1, w: 6, h: 4 } },
  { id: 'host', label: '主机资源', minW: 4, minH: 3, def: { x: 0, y: 5, w: 12, h: 4 } },
  { id: 'sessions', label: '在线会话', minW: 3, minH: 3, def: { x: 0, y: 9, w: 12, h: 5 } },
];

const WIDGET_BY_ID = new Map(GRID_WIDGETS.map((w) => [w.id, w]));

export function widgetLabel(id: string): string {
  return WIDGET_BY_ID.get(id)?.label ?? id;
}

function isObj(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function validCoords(item: UiLayoutItem | undefined): boolean {
  return !!item
    && typeof item.x === 'number' && typeof item.y === 'number'
    && typeof item.w === 'number' && typeof item.h === 'number';
}

/** A fully-positioned overview block (coords always present). */
export function defaultOverviewGrid(): UiLayoutItem[] {
  return GRID_WIDGETS.map((w) => ({ id: w.id, visible: true, ...w.def }));
}

/**
 * Bring any stored overview layout up to the current grid catalogue:
 *  - expand the legacy single `stats` block into the 5 individual tiles
 *    (inheriting its visibility),
 *  - keep stored coords/visibility for known widgets, assign the default
 *    placement to any widget missing coords,
 *  - append catalogue widgets the stored layout predates (visible),
 *  - drop unknown ids.
 * Output items always carry x/y/w/h.
 */
export function migrateOverviewBlocks(stored: UiLayoutItem[] | undefined): UiLayoutItem[] {
  const byId = new Map<string, UiLayoutItem>();
  for (const raw of Array.isArray(stored) ? stored : []) {
    if (isObj(raw) && typeof raw.id === 'string') byId.set(raw.id, raw as UiLayoutItem);
  }

  // Legacy: a single `stats` block → seed the 5 tiles' visibility from it,
  // but only when the tiles aren't already individually present.
  const legacyStats = byId.get('stats');

  return GRID_WIDGETS.map((spec) => {
    const item = byId.get(spec.id);
    const isStatTile = (STAT_TILE_IDS as readonly string[]).includes(spec.id);
    const visible = item
      ? item.visible !== false
      : isStatTile && legacyStats
        ? legacyStats.visible !== false
        : true;
    const coords = validCoords(item)
      ? { x: item!.x!, y: item!.y!, w: item!.w!, h: item!.h! }
      : { ...spec.def };
    return { id: spec.id, visible, ...coords };
  });
}

export function minSizeOf(id: string): { minW: number; minH: number } {
  const spec = WIDGET_BY_ID.get(id);
  return { minW: spec?.minW ?? 1, minH: spec?.minH ?? 1 };
}

// ─── Per-widget config (interpreted client-side from the opaque block.config) ───

export const ALL_LOG_LEVELS: LogLevel[] = ['trace', 'debug', 'info', 'success', 'warn', 'error'];

export interface AlertsConfig { count: number; levels: LogLevel[] }
export interface SessionsConfig { sort: 'recent' | 'uin' | 'nickname'; filter: string }

export const DEFAULT_ALERTS_CONFIG: AlertsConfig = { count: 5, levels: ['warn', 'error'] };
export const DEFAULT_SESSIONS_CONFIG: SessionsConfig = { sort: 'recent', filter: '' };

/** Widgets that expose a config form (gear) in the layout editor. */
export const CONFIGURABLE_WIDGETS = new Set(['alerts', 'sessions']);

export function parseAlertsConfig(config: Record<string, unknown> | undefined): AlertsConfig {
  const c = config ?? {};
  const count = typeof c.count === 'number' && Number.isFinite(c.count)
    ? Math.min(50, Math.max(1, Math.trunc(c.count)))
    : DEFAULT_ALERTS_CONFIG.count;
  const levels = Array.isArray(c.levels)
    ? ALL_LOG_LEVELS.filter((l) => (c.levels as unknown[]).includes(l))
    : DEFAULT_ALERTS_CONFIG.levels;
  return { count, levels: levels.length > 0 ? levels : DEFAULT_ALERTS_CONFIG.levels };
}

export function parseSessionsConfig(config: Record<string, unknown> | undefined): SessionsConfig {
  const c = config ?? {};
  const sort = c.sort === 'uin' || c.sort === 'nickname' || c.sort === 'recent'
    ? c.sort
    : DEFAULT_SESSIONS_CONFIG.sort;
  const filter = typeof c.filter === 'string' ? c.filter.slice(0, 100) : '';
  return { sort, filter };
}
