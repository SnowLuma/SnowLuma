# Changelog

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
