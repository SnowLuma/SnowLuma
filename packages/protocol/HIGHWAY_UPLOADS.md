# Media transfer settings

## Video upload connections

Video uploads use one connection by default. In **Settings → Global configuration →
Video upload connections**, choose 1, 2, 3 or 4 connections. The equivalent setting
in `config/snowluma.json` is:

```json
{
  "videoUploadConcurrency": 1
}
```

The setting applies to all accounts. Saving through the WebUI affects the next
video upload; uploads already preparing or sending retain their original value.
Restart SnowLuma after editing the file manually. Missing values in older
configurations mean one connection. Invalid values are reported, not clamped.
Partial configuration saves and configuration backups preserve this setting.

Parallelism applies only to video bodies. Covers, images, voice messages and file
uploads retain their existing behavior. Videos no larger than 2 MiB still use one
connection. The final video chunk waits until all preceding chunks are confirmed.
The setting does not change OneBot actions, message segments or response shapes.

An interrupted connection retries only its unconfirmed chunk, within a bounded
retry budget. Known server backpressure reduces that upload to one active request
and retries after a delay. A server rejection, invalid acknowledgement or exhausted
retry budget fails the upload. A failed upload is never silently reported as sent.

Debug logs separate video preparation from transfer duration and report requested
and effective concurrency, connections and retries. Trace logs include per-chunk
attempts, acknowledgement progress and failure context. Higher concurrency does
not guarantee a particular speed; compare the same file and network conditions,
excluding cached uploads, before drawing performance conclusions.

Regression tests use isolated transports and cover concurrency bounds,
out-of-order acknowledgements, a stalled early chunk, retry exhaustion, backpressure
and cleanup. They do not establish real QQ delivery or upload throughput.

## Upload timeouts and node selection

All Highway HTTP uploads (including images, voice, video and files) snapshot
these deployment-wide environment variables when each file starts transferring:

| Variable | Default | Meaning |
| --- | --- | --- |
| `SNOWLUMA_HIGHWAY_UPLOAD_IDLE_TIMEOUT_MS` | `30000` | Maximum wait without response bytes during one request, in milliseconds. Resets when response bytes arrive. |
| `SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS` | `1800000` | Total transfer budget for one file, in milliseconds (30 minutes). Shared by all chunks, connections, writes, response waits and retry delays. |

For example, a deployment sending small images can use:

```sh
SNOWLUMA_HIGHWAY_UPLOAD_IDLE_TIMEOUT_MS=5000
SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS=120000
```

Restart the process/container with these variables. Both values must be integers
from 1 to 2147483647; invalid values fail the upload visibly rather than silently
using a default. The total budget does not reset after a successful chunk, after
incoming bytes, or on a different node. The idle timer starts when the HTTP request
begins, including writes; slow connections may need a larger value. Source downloads,
hashing and QQ upload preparation precede this transfer budget. Video bodies and
their covers are separate files with separate budgets.

Transport failures retry only the unconfirmed chunk. Each chunk allows at least
three attempts, or enough attempts to cover all distinct supplied candidates when
there are more than three, subject to the file's total budget. Each connection has
a three-second handshake limit. An expired total budget aborts all workers and
closes their connections; outstanding filesystem reads are drained before closing
the source, so cleanup can finish after that deadline. Explicit server rejection
and invalid acknowledgements still fail immediately. Backpressure retries remain
bounded separately and share the same file deadline.

Node observations belong to the account session and upload type, keyed by the
complete host and port. A validated successful upload acknowledgement is preferred
for five minutes; a transport failure lowers that endpoint's priority for thirty
seconds. Unknown endpoints remain eligible ahead of recent failures, and failures
never permanently exclude a candidate. Only destinations supplied for the current
upload can be selected. The history holds at most 128 observations per account
session, contains no tickets or payloads, and is released when that account's
identity object is discarded. A process restart clears it.

TRACE logs show the effective timeouts and candidate order. Read timeouts include
the current write/read phase, completed write byte count, received byte count and
whether response headers were seen. Total-budget exhaustion is reported separately
as `upload_timeout`; failed transfers remain failed OneBot actions.

## Media download limits

Two deployment-wide knobs bound HTTP media downloads in `highway/utils.ts`. They are
environment variables rather than per-account OneBot settings because every caller
reaches the same download engine (`loadBinarySource` / `stageSourceToDisk`):

```sh
# One HTTP attempt, in milliseconds. Default 60000.
SNOWLUMA_HTTP_DOWNLOAD_TIMEOUT_MS=180000
# Cap on one binary source buffered in memory, in bytes. Default 1073741824 (1 GiB).
SNOWLUMA_MAX_BINARY_DOWNLOAD_BYTES=2147483648
```

Both default to their previous hardcoded values, so an unconfigured deployment
behaves exactly as before. Invalid values are logged and ignored, falling back to the
default. Callers that already pass an explicit ceiling keep it: group/private files
and flash transfer still use 4 GiB, and inline `base64://` / `data:` flash sources
keep the 1 GiB buffered-load ceiling.

`SNOWLUMA_HTTP_DOWNLOAD_TIMEOUT_MS` is not related to
`SNOWLUMA_DOWNLOAD_FILE_TIMEOUT_MS` (used by the `download_file` OneBot action): the
former bounds highway media downloads, the latter the action's own file staging.
