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

- `list_actions({ category? })` — lightweight index (name / category / summary / aliases / `readOnly` / `stream`).
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
- `invoke_action({ action, params?, execution? })` — calls **any known** action, including ones
  with side effects (send a message, change a group, …). Annotated `destructiveHint`
  + `openWorldHint`. **Only available in write mode.** For automatic local-file
  upload, pass `execution: { input_file: "/path/on/the/mcp/host" }` with
  `action: "upload_file_stream"`; this option is never forwarded as OneBot params.

Ordinary actions pass the OneBot envelope through verbatim — a logical failure
(`retcode≠0`) comes back as data with its `wording`. Stream protocol failures are
reported as MCP errors because they mean no complete stream result was committed.

### Configuration (env)

| Variable | Meaning |
| --- | --- |
| `SNOWLUMA_MCP_ENDPOINT` | OneBot HTTP endpoint, e.g. `http://127.0.0.1:3000/`. **Absent → docs-only** (execution tools hidden). |
| `SNOWLUMA_MCP_TOKEN` | Access token (sent as `Authorization: Bearer …`), if the endpoint requires one. |
| `SNOWLUMA_MCP_TIMEOUT_MS` | Ordinary-action request timeout; for Stream Actions, connection timeout **and per-read idle timeout** (the idle deadline resets after every body read). Default `30000`. Invalid values fail startup. |
| `SNOWLUMA_MCP_MODE` | `docs` \| `read` \| `write`. Default: `read` when an endpoint is set, else `docs`. Invalid values fail startup. |
| `SNOWLUMA_MCP_STREAM_DIR` | Directory on the MCP host for completed Stream Action downloads. Created and validated at startup. Default: `os.tmpdir()/onebot-mcp-downloads`. |
| `SNOWLUMA_MCP_UPLOAD_ROOT` | Existing directory on the MCP host from which automatic uploads may read. Automatic upload is disabled when absent. |
| `SNOWLUMA_MCP_MAX_STREAM_BYTES` | Per-file download/upload ceiling in bytes. Positive integer up to 4 GiB; default `4294967296`. Invalid values fail server startup. |

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
        "SNOWLUMA_MCP_MODE": "write",
        "SNOWLUMA_MCP_STREAM_DIR": "/var/tmp/onebot-mcp-downloads",
        "SNOWLUMA_MCP_UPLOAD_ROOT": "/home/me/mcp-share"
      }
    }
  }
}
```

### Stream Actions

The existing `query_action` / `invoke_action` tools automatically select the
ordinary or Stream Action HTTP transport from the generated catalog. No separate
MCP tool is needed.

- File downloads (`download_file_stream`, `download_file_image_stream`, and
  `download_file_record_stream`) are parsed frame-by-frame. Base64 chunks are
  decoded directly into a randomly named `.part` file under the controlled
  download directory, hashed incrementally, and atomically renamed only after a
  valid `file_complete` terminal frame. The MCP result contains only
  `file_path`, `file_size`, `sha256`, `frame_count`, and `terminal`; the file path
  is on the **MCP host**.
- A client admits at most four top-level active Stream Actions. Download files
  share a directory quota of `2 * SNOWLUMA_MCP_MAX_STREAM_BYTES`; an unknown-size
  download reserves the full per-file limit while active. Successfully committed
  files are **not automatically deleted** by MCP and continue consuming quota;
  the operator must move or delete them when no longer needed.
- Non-file streams such as `test_download_stream` return a bounded frame summary.
  Frame count, summary text, individual wire-frame size, total file bytes, and
  file chunk count are capped. A malformed frame, disconnect, timeout, size
  violation, caller cancellation, idle timeout, or invalid terminal cancels the
  response and removes the partial file. `file_chunk` / `file_complete` frames
  are never admitted without a preceding `file_info` header.
- Automatic upload reads `execution.input_file` only after resolving it inside
  `SNOWLUMA_MCP_UPLOAD_ROOT` (symlink escapes are rejected), hashes and sends it
  in fixed-size chunks, and asks SnowLuma to verify the final SHA-256. Transfer
  fields such as `stream_id`, `chunk_data`, and `chunk_index` are MCP-owned and
  must not also be supplied in `params`. The returned `file_path` is on the
  **SnowLuma/OneBot host** and can be passed to a normal send-file action.
- Automatic upload reset is best-effort **before commit**. If SnowLuma commits
  the file but the `file_complete` response is lost, the upload state has already
  gone and reset cannot remove that committed file. Keep `file_retention`
  non-zero (the default is `300000` ms) so SnowLuma eventually reclaims it.
- Stream Actions remain classified as write operations by the current catalog,
  so they require `SNOWLUMA_MCP_MODE=write` and `invoke_action`.

Example automatic upload:

```json
{
  "action": "upload_file_stream",
  "params": { "file_retention": 300000 },
  "execution": { "input_file": "/home/me/mcp-share/report.pdf" }
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
- Stream downloads never put file Base64 into the model result. Downloads use a
  `.part` + atomic-rename commit; automatic uploads require an explicit realpath-
  fenced root and attempt a pre-commit remote reset if transfer fails.
- A well-behaved client can auto-approve `query_action` (read-only) and prompt for
  `invoke_action` (destructive) using the MCP tool annotations.

## How it stays in sync

The catalog — including each action's `readOnly` flag — is a **build-time snapshot**
generated from `@snowluma/onebot`'s live action specs (`collectActionDocs()`) on
every build, so it auto-tracks action add/remove and read/write reclassification.
The snapshot is pinned to the SnowLuma version it was built from; a new SnowLuma
release republishes a fresh catalog.

This package is generated; do not hand-edit `src/generated/catalog.ts`.
