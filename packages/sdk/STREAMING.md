# Streaming files

Both `SnowLumaHttpClient` and `SnowLumaWebSocketClient` support incremental uploads
and downloads. Existing `request()`, `call()`, `raw()`, `rawResponse()` and
`downloadFile()` keep their single-response behavior. Use the new methods below
when a response contains multiple frames.

## Upload

```ts
import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { SnowLumaHttpClient } from '@snowluma/sdk';

const client = new SnowLumaHttpClient({ baseUrl: 'http://127.0.0.1:3000/' });
const controller = new AbortController();
const path = './photo.png';
const file = await client.uploadFileStream(
    createReadStream(path, { signal: controller.signal }),
    {
        fileSize: (await stat(path)).size,
        filename: 'photo.png',
        signal: controller.signal,
        onProgress: ({ uploadedBytes, fileSize }) => {
            console.log(`${uploadedBytes}/${fileSize}`);
        },
    },
);
console.log(file.file_path, file.file_size, file.sha256);
```

`uploadFileStream(source, options?)` accepts `Uint8Array` (including Node.js
`Buffer`), `Blob`, `ReadableStream<Uint8Array>` or `AsyncIterable<Uint8Array>`.
Byte arrays and blobs provide their own size. Stream sources require `fileSize`:
the server needs the total chunk count before accepting the first chunk. The SDK
rejects input whose actual length differs from the declared size.

The default chunk size is 64 KiB. `chunkSize` accepts 1 through 1048576 bytes,
keeping each encoded request below the standard server HTTP body limit. Input is
read incrementally; chunks are acknowledged sequentially, and `onProgress` is
awaited before continuing. Empty files are supported. Completion is a separate
request and returns `UploadFileStreamComplete`, including the **server's** local
file path; it does not write a local client file or send a QQ message.

Optional settings are `filename`, `expectedSha256`, `fileRetention` (milliseconds;
zero disables server expiry), and `streamId`. The default server retention is five
minutes. A generated ID identifies each upload; an explicit ID must be fresh, not
an existing upload. The helper does not resume or automatically retry transfers.
The server validates `expectedSha256` when provided; the SDK checks the completed
metadata and returned digest against that expectation.

`signal` cancels requests and closes readable sources. For custom async iterables,
pass the same signal to the source and ensure pending reads and iterator cleanup
can finish on cancellation (as the `createReadStream` example does). Cancellation
cannot force an arbitrary producer to resolve its own promises. A failed or
cancelled upload is not finalized; partial server uploads expire after the
server's idle timeout (currently ten minutes). The helper does not issue a reset
request or delete a completed server file automatically.

## Download

```ts
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';

await pipeline(
    client.downloadFileStream(
        { file: file.file_path, chunk_size: 64 * 1024 },
        { onInfo: (info) => console.log(info.file_name, info.file_size) },
    ),
    createWriteStream('./downloaded.png'),
);
```

`downloadFileStream(params, options?)` yields `Uint8Array` chunks and returns
`DownloadFileStreamComplete` as the iterator's final value. `for await` and
`pipeline()` consume chunks and verify completion, but discard that return value;
call `iterator.next()` manually if you need `total_bytes` and `total_chunks` from
the final result. `onInfo` runs before any file bytes are yielded.

Parameters accept a server-side `file` or `file_id`, plus optional `chunk_size`.
The `action` option selects `download_file_stream` (default),
`download_file_image_stream`, or `download_file_record_stream`.

The helper decodes base64 and checks chunk order, chunk lengths and final counts.
A zero initial file size can mean unknown size; final byte and chunk totals still
must match. Missing metadata, malformed frames, truncation and server failures
throw; bytes already consumed are not rolled back. For durable output, write to
a temporary file and rename it after the iteration succeeds.

## Individual frames

```ts
for await (const frame of client.stream('test_download_stream', {})) {
    console.log(frame.type, frame.data_type);
}

for await (const response of client.requestStream('test_download_stream', {})) {
    console.log(response.status, response.retcode, response.data);
}
```

- `requestStream()` yields response envelopes, including a final failed envelope.
- `stream()` yields typed payloads and throws `SnowLumaApiError` (or its auth
  subtype) for failed envelopes, including errors after earlier chunks.
- Both support the five streaming actions: the three downloads,
  `test_download_stream`, and `upload_file_stream`. Each upload request returns
  just one acknowledgement, including `type: 'stream'` chunk ACKs. Low-level
  callers must finalize in a separate request. Reset retains the server's
  existing failed-envelope behavior.
- `AbortSignal`, `echo`, and `timeoutMs` work as on ordinary requests. Timeout
  covers an active streaming request (including WebSocket connection setup);
  uploads apply it to each chunk/finalization request. Zero disables timeout.
  Source reads and application callbacks are not timed by the request timeout.
- Stopping iteration releases client resources. HTTP also cancels its response
  body. WebSocket stops collecting that request without closing the shared socket;
  the protocol has no per-request download cancellation message, so the server
  may continue sending remaining frames. Use unique echoes for transfers; do not
  reuse an aborted transfer's echo while late frames may still arrive.
- WebSocket disconnection fails active transfers; reconnect does not replay them.
- `maxBufferBytes` defaults to 32 MiB and bounds each HTTP frame or the queued
  WebSocket payloads. `maxBufferedFrames` defaults to 256 for WebSocket. An
  overflow throws instead of dropping frames or buffering the entire file.
  HTTP reads follow consumption; WebSocket has no per-request backpressure, so
  prefer HTTP for large downloads to a slow destination.

All new types are exported from `@snowluma/sdk` and `@snowluma/sdk/types`. Custom
`SnowLumaApiClient` subclasses can opt in by implementing `requestStream()`;
request-only subclasses remain compatible and receive an explicit unsupported
error if streaming is attempted.
