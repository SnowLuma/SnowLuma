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
