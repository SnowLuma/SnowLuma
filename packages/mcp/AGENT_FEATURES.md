# MCP agent features

These additions preserve the existing tool names, action parameters, text results,
and read/write gates. No endpoint is contacted by catalog tools or by a local
runtime overview. The action catalog remains a bundled snapshot, not a claim
about the connected server's capabilities.

## Protocol compatibility and catalog caching

The same `snowluma-mcp` stdio command accepts MCP `2026-07-28` clients and
older clients using the `initialize` handshake. The official server SDK selects
the protocol for the connection. Modern clients can use `server/discover` and
per-request metadata without initialization; legacy clients keep their existing
configuration. This does not add a publicly listening MCP HTTP endpoint.

Modern replies carry the protocol's completion and server metadata. Cache hints
depend on whether a response contains static catalog data or private live state:

| Response                                              | Lifetime                                      | Scope                                                                          |
| ----------------------------------------------------- | --------------------------------------------- | ------------------------------------------------------------------------------ |
| `tools/list`                                          | Five minutes                                  | `private`; mode and client capabilities affect tool metadata and availability. |
| `resources/list`                                      | Five minutes, or zero when events are enabled | `private`; UI capability and active event resources affect the list.           |
| `resources/templates/list`                            | Five minutes                                  | `public`; the bundled template list is static.                                 |
| `resources/read` for the action catalog or message UI | Five minutes                                  | `public`; these are bundled static assets.                                     |
| `resources/read` for event resources                  | Zero                                          | `private`; these contain account events and connection state.                  |

These are client cache hints, not a server-side result cache. Tool calls,
including the runtime overview, never receive these hints. The SDK omits
modern-only result fields for legacy clients. Unsupported protocol revisions
are rejected before action execution; they do not trigger an action retry.

## Call tracing

Every tool invocation gets a W3C trace context. Clients can supply `traceparent`
and optional `tracestate` in the tool request's `_meta`:

```json
{
  "name": "query_action",
  "arguments": { "action": "get_status" },
  "_meta": {
    "traceparent": "00-4bf92f3577b34da6a3ce929d0e0e4736-00f067aa0ba902b7-01"
  }
}
```

MCP preserves a valid caller trace ID and creates a new span ID for each call.
Without a valid parent it creates an independent trace. The returned
`_meta.traceparent` identifies that call, including tool errors; the existing
text and structured result envelopes remain unchanged. This works with both
protocol generations.

Ordinary requests, streams, automatic upload chunks, and upload cleanup forward
the call context in HTTP headers, never in OneBot action parameters. Concurrent
calls keep independent headers. To follow a call, match its traceparent in MCP
stderr diagnostics with SnowLuma's `http_trace` entry, then follow that entry's
existing `req#` through action lifecycle logs. SnowLuma correlation requires
TRACE logging and a valid authenticated HTTP request; the remote trace ID does
not replace its local request ID. No telemetry exporter is installed.

MCP's call diagnostics contain the known tool name, traceparent, outcome, failure
category and duration, not message contents, tokens, file paths or arbitrary metadata.
`tracestate` is validated with a maximum of 512 characters and 32 members; it is
forwarded but not logged. Invalid trace metadata produces a fixed diagnostic and
does not reject an otherwise valid action. `baggage` is neither forwarded nor
logged. Trace identifiers are correlation data, not authentication or permission.

## Optional execution services

Existing configurations keep working. Input completion and message previews are
additive tools; event connections and durable tasks require explicit configuration.
For example, set these variables in the MCP client's server environment, replacing
addresses, credentials and paths with the intended SnowLuma instance:

```json
{
  "SNOWLUMA_MCP_MODE": "write",
  "SNOWLUMA_MCP_ENDPOINT": "http://127.0.0.1:3000/",
  "SNOWLUMA_MCP_TOKEN": "<your access token>",
  "SNOWLUMA_MCP_EVENTS_URL": "ws://127.0.0.1:3001/event",
  "SNOWLUMA_MCP_TASK_DIR": "/absolute/private/mcp-tasks",
  "SNOWLUMA_MCP_UPLOAD_ROOT": "/absolute/allowed/uploads"
}
```

The HTTP and WebSocket addresses are independently configured server endpoints;
the WebSocket address is never guessed from the HTTP address. Events reuse
`SNOWLUMA_MCP_TOKEN` in an authorization header. Upload and task directories are
on the MCP host. Omit services that are not needed. Docs mode remains offline.

## Completing missing parameters

`query_action_with_input` and `invoke_action_with_input` use the same arguments,
action lookup and mode gates as `query_action` and `invoke_action`. The existing
tools continue to behave exactly as before. The additional tools ask for input
only when a field listed in the action catalog's top-level `required` array is
absent; they do not infer conditional requirements or optional values.

For example, `invoke_action_with_input` with
`{"action":"send_group_msg","params":{"group_id":20001}}` asks for the
missing message. The form contains one `params_json` string, whose contents are
a JSON object such as `{"message":"Hello"}`. The answer is validated against
the missing fields' catalog schemas before normal action execution. Already
provided fields, the action name and execution options cannot be overwritten;
extra answer fields are rejected. A declined, cancelled or invalid answer does
not execute the action.

Clients must advertise form elicitation support. Modern clients receive
`resultType: "input_required"` and resume using the SDK's request-state and input
response mechanism. Legacy clients with elicitation support use the SDK's
`elicitation/create` flow. Clients without form support receive a tool error and
can provide complete arguments to the original tools instead.

Continuation state is signed, tied to the original tool and arguments, expires
after ten minutes and is consumed once before execution. Concurrent or repeated
answers cannot execute the same continuation twice. A runtime holds at most 256
pending prompts; restart invalidates them rather than replaying work. Completed
arguments bypass the input round entirely. This feature is not a general approval
gate and does not add confirmation prompts to existing action calls.

## Live event resources

With `SNOWLUMA_MCP_EVENTS_URL` configured, read and write modes expose
`subscribe_events` and `unsubscribe_events`. The URL must use `ws:` or `wss:`
without embedded credentials, query parameters or fragments. Listing tools or
resources does not connect; only `subscribe_events` opens the event connection.

```json
{
  "self_id": 10001,
  "types": ["message", "notice"],
  "group_ids": [20001],
  "user_ids": [30001]
}
```

Use the expected logged-in account for required `self_id`; obtain it through
`get_login_info` if necessary. Every incoming event must match this account.
An account mismatch or malformed event stops the connection and is surfaced.
The optional types are `message`, `notice` and `request`; omitted types mean all
three. `message_sent` is included in the message category. Group and user filters
are combined with AND, so a group filter excludes events without a matching
`group_id`. Each ID filter accepts at most 100 distinct positive integers.

The result contains a canonical `snowluma://onebot/events/<id>` resource URI.
Read it with `resources/read`; use `?after=<next_cursor>` on subsequent reads to
obtain newer buffered entries. Cursors belong to that one resource. The response
includes `status`, `next_cursor`, `oldest_cursor`, `dropped_events`, `gap` and
`notification_failed`. Reads do not consume events. Only events received after
subscription creation are available; this is not message-history storage.

Each resource retains at most 256 events and 1 MiB of event data. One runtime
supports at most 16 resources, sharing one account connection. Incoming frames
are limited to 256 KiB. Buffer eviction and disconnection remain visible through
the cursor/gap and status fields; the service does not silently reconnect or
claim missing events were recovered. Release existing resources before changing
accounts or creating a new connection after disconnection.

For updates, use the **canonical URI without `?after`**:

- Modern clients use `subscriptions/listen` with `resourceSubscriptions: [uri]`
  (the TypeScript SDK exposes `client.listen(...)`). Closing that notification
  stream does not release the event buffer; call `unsubscribe_events` explicitly.
- Legacy clients first call `resources/subscribe` with the canonical URI, then
  receive `notifications/resources/updated`. `resources/unsubscribe` also releases
  that event resource. The explicit unsubscribe tool works for both generations.

An update notification indicates that the resource changed; fetch the resource
to read its data. Releasing the last resource closes the WebSocket. Closing the
MCP connection releases its event resources and buffers. No event operation
executes a OneBot business action or sends a QQ message.

## Persistent background transfers

Set an absolute `SNOWLUMA_MCP_TASK_DIR` and use write mode to enable persistent
tasks. Task tools additionally require MCP `2026-07-28` clients advertising
`extensions: {"io.modelcontextprotocol/tasks": {}}`. Legacy clients keep the
existing synchronous execution tools; this server does not expose the obsolete
`tasks/list` or `tasks/result` protocol methods.

`invoke_action_background` takes the same arguments as `invoke_action`, but only
accepts catalog actions marked as streams. For example, it can run
`upload_file_stream` with `execution.input_file` inside the configured upload root.
It writes the task record before starting work and returns a `resultType: "task"`
handle. Ordinary actions continue through the existing tools. The current
background transfer entry does not automatically combine with `_with_input`;
provide the required transfer parameters before starting it.

- `tasks/get` with `{ "taskId": "..." }` returns current state and, when finished,
  the saved result or error. A `completed` task can contain a failed business
  response: inspect the nested result's diagnostics, `status` and `retcode`.
- `tasks/cancel` requests cooperative cancellation. Cancellation does not undo
  remote effects, and a successful completion already in flight may win the race.
  Poll the task again for its final state.
- `tasks/update` accepts input responses only for outstanding task input requests.
  It is the protocol lifecycle endpoint, not an arbitrary task-editing API. The
  current background transfer entry does not itself request interactive input.
- `list_tasks` is an MCP tool returning task metadata without result bodies. It
  accepts optional `cursor` and `limit` (1–100; default 50) and returns `nextCursor`
  when another page is available.

Task handles advertise `pollIntervalMs: 1000` and `ttlMs: null`. Results survive
restart and are not automatically expired or deleted. Restart marks unfinished
work failed with an explicit **unknown remote outcome** message; it never
replays the operation. This persists transfer status/results, not resumable
upload or download execution. There are at most four concurrent tasks and a
16 MiB limit on each persisted task record.

Storage uses an exclusive runtime lease, private directories/files (0700/0600 on
POSIX) and validated records. Corruption, permission errors and write failures
remain errors. The directory is bound to a digest of the effective mode, endpoint
and token; changing that configuration rejects reuse of the directory. Choose a
new private directory for the new configuration and retain the old history.
Credentials are not stored in the scope record, but task results can contain
private account data and should be protected accordingly.

## Message preview panel

`preview_message` is available in every mode and only constructs a draft:

```json
{
  "message_type": "group",
  "target_id": 20001,
  "text": "Hello",
  "reply_to": -123456
}
```

Use `private` for a private conversation. `target_id` must be a positive safe
integer; optional `reply_to` is a non-zero signed 32-bit message ID. The preview
supports literal text and optional quoted replies, not media rendering. Text
that resembles message control codes remains literal text.

Every client receives the same readable text draft, `can_send` flag and
corresponding `invoke_action` arguments. Only clients advertising the MCP Apps
extension `io.modelcontextprotocol/ui` with MIME type
`text/html;profile=mcp-app` receive the tool's UI metadata and listed UI resource.
The panel is a bundled, self-contained HTML asset built with the official Apps
client. It loads no external scripts, fonts or media, opens no network connection
of its own and displays external text without interpreting it as HTML. A missing
packaged asset is a visible packaging error.

Loading the panel sends nothing. Its send button calls the existing
`invoke_action` through the host only after the user clicks, and the server's
write gate still applies. Read/docs mode or a host without server-tool support
keeps sending disabled. The panel prevents duplicate clicks and does not retry
failed or uncertain sends; create a new draft only after checking the outcome.
Successful acknowledgement is not proof of delivery or rendering in QQ.

## Action result schemas and examples

`get_action` and `snowluma://onebot/actions` include `returnsSchema` and
`examples` for every bundled action, including aliases. Both are authored beside
the OneBot action definition and copied into the generated catalog. List/search
responses remain compact; use `get_action` to retrieve the complete contract.

`returnsSchema` describes successful OneBot **`data`**, not the full OneBot
envelope or the MCP `structuredContent` wrapper. Check `status` and `retcode`
before reading it. For stream actions, the schema describes each successful
frame's `data`; MCP downloads instead return saved-file metadata and generic
streams return a frame collection. Error frames and failed envelopes are not
successful results. Unsupported actions use `{ "not": {} }` because they have no
successful result. Compatibility placeholders explicitly document their limits.

Each example has `summary`, `params`, and optional `notes` explaining prerequisites
and identifier sources. These are illustrative calls, never run by catalog tools.
Replace example account/group IDs, opaque handles and paths with values from the
current account before execution. Notes identify operations with multiple steps,
such as completing an upload after all chunks have been acknowledged.

For example, `get_action({ "name": "get_msg" })` documents signed message IDs:

```json
{
  "action": "get_msg",
  "params": { "message_id": -123456 }
}
```

Pass this object to `query_action` with a real message ID. Writes and streams use
`invoke_action` in write mode. For automatic upload, pass
`{ "action": "upload_file_stream", "execution": { "input_file": "/allowed/hello.txt" } }`
to `invoke_action`, with a real file inside the configured upload root. Ordinary
action paths refer to the SnowLuma server, whereas `execution.input_file` and MCP
download paths refer to the MCP host.

Do not substitute zero for a signed message ID. Resource-only forward uploads
and flash shares have a documented `message_id: 0` sentinel; it cannot be used
for message lookup or recall. Also preserve `null` versus `{}`, optional fields,
and decimal strings such as media `file_size` exactly as documented.

## Structured results

Completed tool results use the advertised `outputSchema` and return
`structuredContent` alongside the existing `content` text block. Modern
`input_required` and background task handles are protocol continuations; inspect
their `resultType` first and obtain the completed result through the relevant
continuation or task lifecycle:

```json
{
  "result": { "status": "ok", "retcode": 0, "data": { "message_id": -123 } },
  "diagnostics": { "outcome": "success" }
}
```

`result` is the original payload, including arrays such as the category list.
It is `null` for an MCP tool error. `diagnostics.outcome` is `success`, `failed`,
or `unknown`; failures can include `kind`, `message`, and `next_step`.

Ordinary OneBot business failures still return their original envelope without
setting `isError`. Their structured diagnostics indicate failure. An asynchronous
acknowledgement or a response that does not confirm success has outcome `unknown`.
Transport errors and existing tool/stream errors still set `isError: true`.
Error categories describe known causes; unclassified execution errors are not
guessed from message strings. Neither tool execution nor connection checks retry
automatically. Negative message IDs remain valid and are preserved unchanged.

## Search, filters, and pagination

`search_actions` retains its original case-insensitive substring matching and
catalog order unless `match: "keywords"` is requested. Keyword mode combines
space-separated terms with AND, recognizes a small set of common Chinese/English
synonyms, and ranks exact action names or aliases first.

```json
{
  "query": "群 禁言",
  "match": "keywords",
  "read_only": false,
  "stream": false,
  "limit": 10,
  "offset": 0
}
```

Both `list_actions` and `search_actions` accept optional `category`, `read_only`,
`stream`, `limit` (1–200), and `offset` (non-negative integer). Omitting pagination
returns the complete matching list and preserves `{count, actions}`. With `limit`
or `offset`, `count` is the returned page size, `total` is the matching count, and
`next_offset` is the next page offset or `null`. Pagination applies to the bundled
catalog; it does not issue server requests.

## Runtime overview

`get_runtime_info({})` returns:

- The effective `mode`, `execution_enabled`, and `write_enabled`.
- The bundled catalog version and action count. `server_support` remains
  `unknown`; a matching version alone does not prove action support.
- In execution mode, effective request timeout, file size and directory quota
  limits, concurrent stream limit, download directory, upload root, and whether
  automatic upload is enabled. In docs mode, `transport` is `null`.
- `connection_checked: false`. Local configuration is not proof of a live login.

The overview does not expose the endpoint, access token, or authorization headers.
Configured file paths are paths on the MCP host. All stream actions still require
write mode; `upload_enabled` describes the configured file root, not permission
to bypass that gate.

`get_runtime_info({"check_connection": true})` is available only in read/write
mode with a client. It explicitly queries `get_login_info`, `get_status`, and
`get_version_info`, using the ordinary read-only execution gate. Each entry under
`checks` contains its original response and diagnostics. Partial failures remain
visible. Check the returned status data for online state; a successful HTTP
exchange alone does not establish that the account is online.

## Cancellation and progress

MCP cancellation now reaches ordinary HTTP calls as well as stream actions,
including response-body reads. Ordinary calls retain their request timeout;
streams retain separate connection and per-read idle timeouts. A cancelled call
does not automatically retry. Cancellation or timeout can leave a remote write's
outcome unknown: stopping the wait does not undo an operation already received
by SnowLuma.

When a caller includes `_meta.progressToken`, stream execution emits standard
`notifications/progress` notifications with the same token. File downloads report
decoded bytes written; automatic uploads report bytes acknowledged by the server.
Generic streams report accepted frame counts. A total is included only when a
positive file size is known. Empty files and unknown-size downloads omit it.

Notifications are limited to one per 250 ms, plus the final pending update before
a successful response. Values increase, notifications stop on cancellation or
completion, and callers without a progress token receive none. Notification
delivery failures are surfaced. Progress describes transferred data, not final
commit: only a successful tool result confirms file validation and completion.

The existing file containment, quotas, partial-file cleanup and upload-reset
behavior are unchanged. File bytes never appear in progress messages.
