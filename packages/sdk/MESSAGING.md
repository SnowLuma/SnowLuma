# Media sends, quoted replies, and event waits

These helpers are additive. Existing string media paths still refer to the SnowLuma server, `context.reply()` still sends an ordinary reply, and existing event subscriptions and middleware keep their behavior.

## Send local media

Both HTTP and WebSocket clients provide `sendGroupImage`, `sendPrivateImage`, `sendGroupRecord`, `sendPrivateRecord`, `sendGroupVideo`, `sendPrivateVideo`, `sendGroupFile`, and `sendPrivateFile`.

```ts
import { SnowLumaHttpClient } from '@snowluma/sdk';
import { localFile } from '@snowluma/sdk/node';

const bot = new SnowLumaHttpClient({ baseUrl: 'http://127.0.0.1:3000/' });
const receipt = await bot.sendGroupImage(12345, await localFile('./picture.png'), {
    image: { summary: 'Picture' },
    onProgress: ({ uploadedBytes, fileSize }) => {
        console.log(`${uploadedBytes}/${fileSize} bytes uploaded`);
    },
});
console.log(receipt.message_id);

await bot.sendPrivateFile(67890, await localFile('./report.pdf'), { name: 'Report.pdf' });
```

Sources may be `Uint8Array` (including Node `Buffer`), `Blob` / browser `File`, `ReadableStream<Uint8Array>`, or `AsyncIterable<Uint8Array>` (including a byte-mode Node readable). Streams and async iterables require `fileSize`. A `{ source, filename }` wrapper supplies a name without changing the byte source. Browser `File` names are inferred; an explicit `filename` option overrides them.

`localFile(pathOrFileURL)` is available **only** from `@snowluma/sdk/node`. It returns a named, file-backed Blob without reading the entire file into memory. The file must remain unchanged until sending finishes; missing, non-regular, or changed files produce errors. The root and browser-facing entry points do not import Node filesystem modules. A browser can pass a selected `File` directly.

The helpers await every chunk acknowledgement and upload completion, then use the returned **server path** in the final action. Image, record, and video methods return the ordinary `{ message_id }` result. File methods call the existing file publishing actions and return `{ file_id }`. `sendGroupFile` accepts `folder` / `folderId`; file methods accept a display `name`, defaulting to the uploaded name. Media attributes go under `image`, `record`, or `video`. A `video.thumb` path still refers to the server and is not uploaded automatically.

All [upload options](STREAMING.md) apply, including `chunkSize`, `expectedSha256`, `fileRetention`, `signal`, and `onProgress`. Progress measures acknowledged uploaded bytes, not message delivery. `timeoutMs` is a timeout **per upload request and final send request**, not a deadline for the entire operation or source reads. Use an `AbortSignal` with your own deadline for an overall cancellation policy.

```ts
import { SnowLumaMediaSendError } from '@snowluma/sdk';

try {
    await bot.sendPrivateImage(67890, new Uint8Array([/* image bytes */]), {
        signal: AbortSignal.timeout(60_000),
    });
} catch (error) {
    if (error instanceof SnowLumaMediaSendError) {
        console.error(error.stage, error.cause);
        // error.upload contains completion metadata if uploading finished.
    }
    throw error;
}
```

Errors carry `stage: 'upload' | 'send'`, the original `cause` (including API, abort, and timeout errors), and completed upload metadata when available. Cancellation between stages prevents sending. Cancellation or timeout after dispatch does not prove that the server failed to send: there is no automatic retry, rollback, or remote deletion. Remote retention and partial-upload expiry remain controlled by the existing upload service. The accompanying runtime fix reports a failed group-file chat publication as an error, retaining the uploaded file ID in the error context; it no longer returns success after that failure.

## Quote a message explicitly

```ts
import { SnowLumaWebSocketClient, quoteMessage, text } from '@snowluma/sdk';

const bot = new SnowLumaWebSocketClient();
bot.onGroupMessage(async (event, context) => {
    if (event.post_type === 'message' && event.raw_message === '/ping') {
        await context.quote(text('pong'));
    }
});
await bot.connect();

// HTTP clients or code outside an event handler can compose the same quote.
await bot.sendGroupMessage(12345, quoteMessage(-42, 'Reply body'));
```

`context.quote()` routes to the event's group or private conversation and uses its message ID. It rejects non-message events. IDs are non-zero signed 32-bit integers; negative IDs are preserved. `quoteMessage(id, body, options?)` is also exported from `@snowluma/sdk/messages` and only composes content, without making a request.

Bodies accept strings, CQ strings, a segment, arrays of segments, and message chains. String CQ content retains its original fields and escaping. With `autoEscape: true`, a string becomes literal text following the quote; arrays and chains remain structured. A body that already contains a reply segment is rejected, and inputs are not mutated. This does not fetch the referenced message; the server must be able to resolve its ID.

Old `SnowLumaEventContext` objects and explicitly typed handlers remain valid. SDK-created contexts and inferred client callbacks expose `SnowLumaEventContextWithQuote`. To annotate a reusable new handler, use `EventHandler<MyEvent, SnowLumaEventContextWithQuote<MyEvent>>` (or the corresponding context parameter of `EventMiddleware` / `CommandHandler`).

## Wait for a future event

`waitForEvent(predicate?, options?)` and `waitForMessage(predicate?, options?)` are available on the WebSocket client. Both also accept just the options object. Synchronous type-guard predicates narrow the resolved type; boolean predicates filter without claiming a narrower type.

```ts
const controller = new AbortController();
await bot.connect();
try {
    // Register before sending so a fast reply cannot arrive before the listener.
    const reply = bot.waitForMessage(
        (event) => event.post_type === 'message'
            && event.message_type === 'private'
            && event.user_id === 67890,
        { timeoutMs: 30_000, signal: controller.signal },
    );
    const [incoming] = await Promise.all([
        reply,
        bot.sendPrivateMessage(67890, 'Ready?', { signal: controller.signal }),
    ]);
    console.log(incoming.raw_message);
} finally {
    controller.abort(); // Also releases the wait if sending failed first.
}
```

Waits register synchronously and do not connect, replay history, consume events from other listeners, or persist across reconnects. They observe the same public event stream as `onEvent`, **after middleware**; events stopped by middleware are not visible. `waitForMessage` includes both `message` and `message_sent`, so filter direction, conversation, and sender when needed. Multiple waits can resolve from the same event.

The default timeout is the client's `requestTimeoutMs` (30 seconds by default); `0` disables it. Timeout rejects with `SnowLumaTimeoutError`, cancellation with `SnowLumaAbortError`, and disconnect or explicit `close()` with `SnowLumaConnectionError`. Predicate exceptions reject with their original error. Every completion path removes its listener, abort handler, and timer. Cancellation affects the wait only; it does not close the client or undo a sent message.
