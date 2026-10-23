# MCP agent features

These additions preserve the existing tool names, action parameters, text results,
and read/write gates. No endpoint is contacted by catalog tools or by a local
runtime overview. The action catalog remains a bundled snapshot, not a claim
about the connected server's capabilities.

## Structured results

Every tool advertises an `outputSchema` and returns `structuredContent` alongside
the existing `content` text block:

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
