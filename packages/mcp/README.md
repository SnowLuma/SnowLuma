# @snowluma/mcp

An [MCP](https://modelcontextprotocol.io) server for the **SnowLuma OneBot action
catalog**. It runs in two modes from one binary:

- **docs** (default) — read-only: every action's docs, parameters, cross-field
  constraints, and a ready-to-use **JSON Schema**, so an LLM can answer "what
  params does `set_group_ban` take?" without holding the whole catalog in context.
- **execution** (opt-in) — when pointed at a running OneBot HTTP endpoint, the LLM
  can also *call* actions: read-only ones freely, write ones behind a gate.

## Docs only (default)

Add to your MCP client (Claude Desktop, Cline, …) — no endpoint, no execution:

```json
{
  "mcpServers": {
    "snowluma": { "command": "npx", "args": ["-y", "@snowluma/mcp"] }
  }
}
```

### Docs tools

- `list_actions({ category? })` — lightweight index (name / category / summary / aliases / `readOnly`).
- `get_action({ name })` — full doc for one action incl. `inputSchema` and `readOnly` (accepts aliases).
- `search_actions({ query })` — fuzzy match over name / summary / aliases.
- `list_categories()` — categories and their action counts.

Also exposes the whole catalog as a resource: `snowluma://onebot/actions`.

## Execution (opt-in)

Point the server at a running SnowLuma instance's **OneBot HTTP endpoint** (the
`httpServer` network adapter) and it gains two execution tools:

- `query_action({ action, params? })` — calls a **read-only** action (e.g. `get_*`,
  `can_*`) and returns the full OneBot response. Annotated `readOnlyHint`. Refuses
  write actions (points you to `invoke_action`).
- `invoke_action({ action, params? })` — calls **any known** action, including ones
  with side effects (send a message, change a group, …). Annotated `destructiveHint`
  + `openWorldHint`. **Only available in write mode.**

Both pass the OneBot envelope through verbatim — a logical failure (`retcode≠0`)
comes back as data with its `wording`; only a transport failure is an error.

### Configuration (env)

| Variable | Meaning |
| --- | --- |
| `SNOWLUMA_MCP_ENDPOINT` | OneBot HTTP endpoint, e.g. `http://127.0.0.1:3000/`. **Absent → docs-only** (execution tools hidden). |
| `SNOWLUMA_MCP_TOKEN` | Access token (sent as `Authorization: Bearer …`), if the endpoint requires one. |
| `SNOWLUMA_MCP_TIMEOUT_MS` | Per-request timeout (default `30000`). |
| `SNOWLUMA_MCP_MODE` | `docs` \| `read` \| `write`. Default: `read` when an endpoint is set, else `docs`. |

**Read mode** — the LLM can query read-only actions, but cannot perform any write:

```json
{
  "mcpServers": {
    "snowluma": {
      "command": "npx",
      "args": ["-y", "@snowluma/mcp"],
      "env": {
        "SNOWLUMA_MCP_ENDPOINT": "http://127.0.0.1:3000/",
        "SNOWLUMA_MCP_TOKEN": "your-access-token"
      }
    }
  }
}
```

**Write mode** — also enables `invoke_action` (the bot can send messages, manage
groups, etc.). Enable deliberately:

```json
{
  "mcpServers": {
    "snowluma": {
      "command": "npx",
      "args": ["-y", "@snowluma/mcp"],
      "env": {
        "SNOWLUMA_MCP_ENDPOINT": "http://127.0.0.1:3000/",
        "SNOWLUMA_MCP_TOKEN": "your-access-token",
        "SNOWLUMA_MCP_MODE": "write"
      }
    }
  }
}
```

### Safety model

- **Read/write is classified per action** in the source specs (by what the action
  actually does, not its name) and baked into the catalog. The default is *write*:
  an action is callable via `query_action` **only** if it is explicitly read-only.
- **The mode gate is enforced on every call**, not just by hiding tools — calling
  `invoke_action` outside write mode is refused even if a client sends it directly.
- **Unknown actions are rejected** by both tools (only catalog actions are callable),
  so typos and non-catalog internal actions can't be driven.
- A well-behaved client can auto-approve `query_action` (read-only) and prompt for
  `invoke_action` (destructive) using the MCP tool annotations.

## How it stays in sync

The catalog — including each action's `readOnly` flag — is a **build-time snapshot**
generated from `@snowluma/onebot`'s live action specs (`collectActionDocs()`) on
every build, so it auto-tracks action add/remove and read/write reclassification.
The snapshot is pinned to the SnowLuma version it was built from; a new SnowLuma
release republishes a fresh catalog.

This package is generated; do not hand-edit `src/generated/catalog.ts`.
