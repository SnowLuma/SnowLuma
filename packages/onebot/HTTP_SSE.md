# OneBot HTTP event streams

An HTTP server can serve actions and Server-Sent Events on the same listener.
Enable **SSE** in the WebUI's HTTP API adapter, or set `enableSse: true` on an
entry in `networks.httpServers`. The default is `false`; existing HTTP and
WebSocket configurations keep their behavior. SSE and `enableWebSocket` may both
be enabled.

```json
{
  "name": "web-client",
  "host": "127.0.0.1",
  "port": 3000,
  "path": "/api",
  "enableSse": true,
  "accessToken": "replace-with-your-token",
  "messageFormat": "array",
  "reportSelfMessage": false
}
```

`GET /api/_events?access_token=<token>` opens the event stream. Actions continue
to use `POST /api/<action>` with a JSON parameter object. HTTP requests accept
`Authorization: Bearer <token>`, `Authorization: <token>` (for Stapxs QQ Lite), or
the `access_token` query parameter. The configured token and bind address still
apply. Empty tokens retain the existing unauthenticated HTTP behavior.

```js
const events = new EventSource(`api/_events?access_token=${encodeURIComponent(token)}`);
events.onmessage = ({ data }) => console.log(JSON.parse(data));
events.onerror = () =>
  console.error('Event connection interrupted; check connection and authentication');

const response = await fetch('api/get_status', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', Authorization: token },
  body: JSON.stringify({}),
});
if (!response.ok) throw new Error(`Action failed: HTTP ${response.status}`);
console.log(await response.json());
// Close the stream when the owning page/component is disposed.
// events.close();
```

Configure Stapxs's SSE event address as `api/_events` and HTTP address as `api`
when both are exposed under that same-origin proxy prefix. Forward the request
path, query string, authorization and `Last-Event-ID` headers unchanged. SnowLuma
does not add cross-origin access grants. TLS and any additional proxy
authentication remain the proxy's responsibility.

Responses use `text/event-stream`, `Cache-Control: no-cache, no-transform`, and
`X-Accel-Buffering: no`. Events are ordinary unnamed `data:` frames containing
OneBot JSON. Connection lifecycle and current heartbeat events bootstrap each
subscription. Transport comments (`: ping`) are sent every 15 seconds; they are
not OneBot events. The browser's reconnect delay is 3 seconds.

## Reconnect and resource limits

Every broadcast event has an opaque `id`. A reconnect with `Last-Event-ID`
replays events after that cursor, in order, before connection bootstrap events
and subsequent live events. Native EventSource sends this header automatically
when reconnecting the same object. A new subscription without the header starts
at the present and does not receive old messages.

Each adapter retains at most 256 events and 8 MiB in memory, including while no
client is connected. This is a short reconnect window, not durable message
history. Accounts and adapter instances have independent histories. Event IDs
are invalidated on restart, shutdown, token rotation, report-policy changes or
disabling SSE. Neither replay nor live delivery bypasses `messageFormat` or
`reportSelfMessage`.

An invalid cursor returns HTTP 400. An expired, future or foreign cursor returns
HTTP 409 with `wording` explaining that replay is unavailable. There is no silent
fallback to live-only delivery. After reconciling the application's state/history,
close and recreate EventSource to subscribe without the old cursor. EventSource's
error callback does not expose the HTTP error body; fetch-based consumers can
inspect it directly. Bootstrap events can share the latest broadcast cursor and
must not be treated as newly persisted message events.

Each client's pending output is limited to 8 MiB. Slow readers are disconnected
with a warning instead of retaining unbounded events or blocking other clients.
A single frame exceeding this limit also disconnects that client. Reconnection
is subject to the same replay limits. Disconnect, hot reload and shutdown release
connections and heartbeat timers; rotating the token revokes existing streams.

Tests: `pnpm --filter @snowluma/onebot exec vitest run tests/http-server-sse.test.ts tests/http-sse-backpressure.test.ts tests/http-server-websocket-config.test.ts`.
