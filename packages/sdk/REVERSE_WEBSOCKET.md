# Reverse WebSocket connections

`@snowluma/sdk/node` can accept OneBot reverse WebSocket connections. SnowLuma
connects **to your SDK program** and sends events; your program sends actions
back over that same connection. The ordinary `createWebSocketClient()` continues
to dial a SnowLuma WebSocket server. Neither SDK entry acts as a QQ implementation
for NoneBot/AstrBot; SnowLuma's `networks.wsClients` already serves that use case.

```ts
import { text } from '@snowluma/sdk';
import { createReverseWebSocketServer } from '@snowluma/sdk/node';

const server = createReverseWebSocketServer({
  host: '127.0.0.1',
  port: 3002,
  path: '/onebot/v11/ws',
  accessToken: process.env.ONEBOT_ACCESS_TOKEN,
  // Optional: restrict which accounts may connect, in addition to the token.
  selfIds: ['10001'],
});

server.on('error', (error) => console.error('Reverse connection failed', error));
server.on('rejected', ({ status, reason }) => console.error('Handshake rejected', status, reason));
server.on('connection', (bot) => {
  console.log('Connected account', bot.selfId);
  bot.onMessage(async (_event, context) => {
    await context.reply(text('received'));
  });
});
server.on('disconnect', ({ client, code }) => console.log('Disconnected', client.selfId, code));
await server.listen();
// Await server.close() when shutting down your application.
```

Configure the matching SnowLuma account with an entry in `networks.wsClients`:

```json
{
  "name": "sdk",
  "url": "ws://127.0.0.1:3002/onebot/v11/ws",
  "accessToken": "same-token-as-the-sdk-server",
  "role": "Universal",
  "messageFormat": "array",
  "reportSelfMessage": false
}
```

Use the address of the SDK host if the two processes run on different machines.
The listener binds only to loopback by default. Authentication accepts a Bearer
header or `access_token` query parameter. Empty/omitted tokens mean no token
check. Account and role headers are still mandatory. No credentials or frame
bodies are included in handshake rejection events.

## Sessions and channels

`connection` supplies a `SnowLumaReverseWebSocketSession` with `selfId` (string),
`canCallActions`, `canReceiveEvents` and the existing forward client's helpers:
`onMessage`, middleware, `waitForMessage`, `getStatus`, message sends, `request`,
`requestStream`, upload and download helpers. Signed message IDs, response errors,
timeouts, cancellation and stream limits retain their existing meaning.

`server.getClient(selfId)` and the read-only `server.clients` snapshot expose live
sessions. Each account owns its pending requests and event handlers. Events must
match the account declared by `X-Self-ID`; mismatches close the session and report
an error. Duplicate active channels receive HTTP 409 and do not replace a healthy
session. An optional account allowlist rejects unknown accounts with HTTP 403.

Universal mode carries both actions and events. For separate channels, configure
one SnowLuma `Api` connection and one `Event` connection using the same account
and server address. `API` is also accepted in the wire header. Both share one SDK
session, so an event handler's `context.reply()` uses the API channel. `connection`
fires when the first channel arrives; `channel` fires for each accepted channel:

```ts
server.on('channel', ({ client, role }) => {
  console.log(client.selfId, role, client.canCallActions, client.canReceiveEvents);
});
```

Wait for `canCallActions` before sending actions in split mode. Calling an action
on an Event-only session fails explicitly. Closing either half ends the entire
session and its sibling channel. SnowLuma owns reconnect timing; the next
connection creates a new session and emits `connection` again, where handlers
should be registered anew. Old session objects cannot reconnect themselves.
Pending requests, stream iterators and event waits fail on disconnect. Actions
are never automatically replayed because the remote side may already have
executed them. This transport does not persist events missed while disconnected.

## Limits, errors and ownership

The defaults are 100 MiB per incoming message, 16 MiB of outgoing buffered bytes
per channel, 128 simultaneous channels, a 30-second action timeout and a
30-second ping interval. Configure `maxPayloadBytes`, `maxBufferedBytes`,
`maxConnections`, `requestTimeoutMs` and `heartbeatIntervalMs` as needed. A zero
request timeout waits indefinitely; a zero heartbeat interval disables pings.
Other limits must be positive integers. All timers are cleaned up on close.
Oversized inbound messages close with 1009; outbound capacity failures reject
the action without enqueueing it. A peer missing the next ping check is terminated
(normally within two heartbeat intervals).

Register a server `error` handler: unhandled errors follow Node's EventEmitter
error contract and throw. Session transport, parsing and asynchronous event-handler
failures are forwarded there. Invalid peer JSON and cross-account/channel frames
close the connection; startup bind errors reject `listen()` directly.

To reuse an HTTP or HTTPS server, pass `server` instead of `host`/`port`, after
that server has started listening. Only the configured upgrade path belongs to
the SDK. Ordinary requests and other upgrade paths remain with their existing
handlers. `close()` releases SDK connections and listeners without closing the
external server. TLS configuration remains with that HTTPS server or your proxy;
there is no automatic downgrade. Internally owned listeners are closed by the
SDK. Closing connections have a bounded handshake grace period before termination.

Only the Node subpath imports the `ws` runtime dependency; browser-facing SDK
entry points retain their existing imports. TypeScript Node consumers should
include their normal `@types/node` development dependency and enable `"types": ["node"]` in their TypeScript configuration.

Validation uses real local WebSockets and SnowLuma's `WsClientAdapter` with the
actual action and stream handlers, isolated from QQ accounts. It covers Universal
and split channels, identity/authentication, message replies, multi-account echoes,
disconnect cleanup, limits, heartbeat, external-server ownership and published
NodeNext/bundler package consumers.
