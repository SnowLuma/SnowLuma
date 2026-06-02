# @snowluma/mcp

A read-only [MCP](https://modelcontextprotocol.io) server that exposes the
**SnowLuma OneBot action catalog** — every action's docs, parameters, cross-field
constraints, and a ready-to-use **JSON Schema** — to LLM clients.

Point an LLM at it and it can answer "what params does `set_group_ban` take?" or
"which actions send messages?" on demand, without holding the whole catalog in
context.

## Usage

Add to your MCP client (Claude Desktop, Cline, …):

```json
{
  "mcpServers": {
    "snowluma": { "command": "npx", "args": ["-y", "@snowluma/mcp"] }
  }
}
```

## Tools

- `list_actions({ category? })` — lightweight index (name / category / summary / aliases).
- `get_action({ name })` — full doc for one action incl. `inputSchema` (accepts aliases).
- `search_actions({ query })` — fuzzy match over name / summary / aliases.
- `list_categories()` — categories and their action counts.

Also exposes the whole catalog as a resource: `snowluma://onebot/actions`.

## How it stays in sync

The catalog is a **build-time snapshot** generated from `@snowluma/onebot`'s live
action specs (`collectActionDocs()`) on every build — so it auto-tracks action
add/remove and the published package carries **zero runtime dependency** on the
private `@snowluma/onebot`. The snapshot is pinned to the SnowLuma version it was
built from; a new SnowLuma release republishes a fresh catalog.

This package is generated; do not hand-edit `src/generated/catalog.ts`.
