# Changelog

## Unreleased

- Add one-step local media sends, the optional `@snowluma/sdk/node` file source, stage-aware errors, explicit quoted replies, and cancellable WebSocket event waits; see [MESSAGING.md](MESSAGING.md). Existing methods and handler/context types remain compatible.
- Report group-file chat publication failures through the runtime's existing error response instead of returning a successful upload result after publication fails.
- Add HTTP and WebSocket `requestStream()` / `stream()`, incremental `uploadFileStream()` / `downloadFileStream()` helpers, cancellation, bounded response buffering, and transfer validation. Existing single-response methods remain unchanged; see [STREAMING.md](STREAMING.md).
- Add parameter and result types for the remaining 57 actions and three aliases, covering every registered action name while preserving existing client methods and type mappings.
- Describe album pagination and media, Qzone, flash transfers, stickers, group settings, and stream frame payloads; retain numeric-string inputs and signed message IDs.
- Fix native Node.js ESM imports for the package root and all supported subpaths without requiring a bundler.
- Restore `@snowluma/sdk/actions` and the root exports `SNOWLUMA_ACTIONS`, `isSnowLumaAction`, and `SnowLumaKnownAction`, including current action names and compatibility aliases.
- Require patched Node.js releases: 24.22.1 or newer in the 24.x line, or 26.12.1 and newer.

## 2.0.0

Upgrade to Node.js 24 or newer before updating the SDK. SDK and application versions are released together.

- Add typed `get_qzone_msg_detail` support for reading a post and its comment page with inline replies.
- Release cancellation listeners as soon as a request stops waiting for a connection.
- Isolate WebSocket connection lifetimes and release request timers and abort listeners on every outcome.
- Reject duplicate in-flight WebSocket echoes instead of overwriting the original request.
- Add `getGroupShareLink()` and typed `get_group_share_link` support for group invitation links.
- Breaking: require Node.js 24 or newer.
- Add `CustomReplySegment` and `message.customReply()` for inline quote previews inside merged-forward nodes.
- Expose optional inline content and quote metadata on received `ReplySegment` values.
- Reject CQ serialization of nested custom-reply content instead of silently stringifying message objects.
- Preserve string custom-reply content and metadata when parsing CQ strings.
- Decode CQ parameters once so literal entity text such as `&#44;` survives round trips.

## 0.1.0

- Initial SnowLuma TypeScript SDK package.
- Added HTTP and WebSocket clients for OneBot APIs.
- Added event middleware, command matching, request context helpers, and message chain builders.
- Added structured SDK error classes and per-request `AbortSignal` support.
