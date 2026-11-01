# Video upload connections

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
