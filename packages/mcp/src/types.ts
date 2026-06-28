// The MCP's own view of the OneBot action catalog. Mirrors @snowluma/onebot's
// ActionDoc, but is defined HERE so the published package does not couple to
// onebot's internals — the generated `catalog.ts` (a build-time snapshot) is the
// only contract (ADR-0005: the wire/data shape is the seam, not a shared type).

export interface CatalogParam {
  name: string;
  /** Display type ('uint' | 'int' | 'messageId' | 'string' | 'bool' | 'message' | 'enum' | 'X[]' | 'raw'). */
  type: string;
  required: boolean;
  default?: unknown;
  desc?: string;
  values?: ReadonlyArray<string | number>;
  /** JSON Schema fragment for this single field. */
  schema?: Record<string, unknown>;
}

export interface CatalogAction {
  name: string;
  aliases: string[];
  category?: string;
  summary?: string;
  returns?: string;
  /** JSON Schema for the action's `data` payload (absent when undocumented). */
  returnsSchema?: Record<string, unknown>;
  /** True only for pure data-fetch actions (no side effects). Drives the
   *  read/write tool routing: read-only → query_action, else → invoke_action.
   *  Classified at the source spec by what the action's `run` actually does. */
  readOnly: boolean;
  params: CatalogParam[];
  /** Cross-field invariants, e.g. "exactly one of: message_id | (group_id+user_id)". */
  invariants: string[];
  /** Composed JSON Schema for the whole params object. */
  inputSchema: Record<string, unknown>;
}

export interface CatalogCategory {
  category: string;
  count: number;
}
