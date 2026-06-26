// Phase-0 safety net for the bootstrap-meta deepening: characterize the
// CURRENT observable behavior the refactor must preserve —
//   1. event-filter `shapeEventForAdapter` shaping rules (the policy that
//      the lifted `metaFrame` primitive will wrap),
//   2. ws-client emits exactly [connect, enable, heartbeat] on socket open,
//      shaped per options, honoring the role guard,
//   3. ws-server emits the same triplet to an Event connection, and on
//      close() broadcasts a single `disable` lifecycle to non-Api conns.
//
// Mirrors ws-client-stale-close.test.ts: `@snowluma/websocket`'s native
// addon isn't built in a plain checkout, so WebSocket + WebSocketServer are
// faked via vi.hoisted + vi.mock and driven explicitly.

import { beforeEach, describe, expect, it, vi } from 'vitest';

const { FakeWebSocket, FakeWebSocketServer, clientInstances, servers } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const clientInstances: FakeWebSocket[] = [];
  const servers: FakeWebSocketServer[] = [];

  class FakeWebSocket extends EventEmitter {
    public readyState = 1; // OPEN
    public readonly sent: string[] = [];
    public readonly url: string;
    constructor(url = '', _opts?: unknown) {
      super();
      this.url = url;
      clientInstances.push(this);
    }
    send(payload: string, cb?: (err?: Error | null) => void): void {
      this.sent.push(payload);
      cb?.(null);
    }
    close(): void { this.readyState = 3; }
    simulateOpen(): void { this.emit('open'); }
  }

  class FakeWebSocketServer extends EventEmitter {
    public closed = false;
    constructor(_opts: unknown) {
      super();
      servers.push(this);
    }
    close(): void { this.closed = true; }
    /** Drive a client connection through the adapter's 'connection' handler. */
    simulateConnection(socket: FakeWebSocket, request: unknown): void {
      this.emit('connection', socket, request);
    }
  }

  return { FakeWebSocket, FakeWebSocketServer, clientInstances, servers };
});

vi.mock('@snowluma/websocket', () => ({
  WebSocket: FakeWebSocket,
  WebSocketServer: FakeWebSocketServer,
}));

import { shapeEventForAdapter, resolveReportOptions } from '../src/event-filter';
import { WsClientAdapter } from '../src/network/ws-client-adapter';
import { WsServerAdapter } from '../src/network/ws-server-adapter';
import type { NetworkAdapterContext } from '../src/network/adapter';
import type { JsonObject, WsClientNetwork, WsServerNetwork } from '../src/types';

// Distinguishable meta events so the bootstrap triplet is identifiable on the
// wire (the real ctx builds real OneBot meta_event objects).
function ctx(): NetworkAdapterContext {
  return {
    uin: '10001',
    api: { processRequest: async () => '' } as never,
    buildLifecycleEvent: (sub) => ({ post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: sub }),
    buildHeartbeatEvent: () => ({ post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 5000 }),
  };
}

const parse = (s: string) => JSON.parse(s) as JsonObject;

describe('event-filter shapeEventForAdapter — shaping policy (characterization)', () => {
  const arrayOpts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: false });
  const stringOpts = resolveReportOptions({ messageFormat: 'string', reportSelfMessage: false });
  const selfOpts = resolveReportOptions({ messageFormat: 'array', reportSelfMessage: true });

  it('passes meta_event (and any non-message) through unchanged', () => {
    const meta = { post_type: 'meta_event', meta_event_type: 'heartbeat' } as JsonObject;
    expect(shapeEventForAdapter(meta, arrayOpts)).toEqual(meta);
    expect(shapeEventForAdapter(meta, stringOpts)).toEqual(meta);
  });

  it('drops message_sent when reportSelfMessage is false, keeps it when true', () => {
    const sent = { post_type: 'message_sent', message: [{ type: 'text', data: { text: 'hi' } }], raw_message: 'hi' } as JsonObject;
    expect(shapeEventForAdapter(sent, arrayOpts)).toBeNull();
    expect(shapeEventForAdapter(sent, selfOpts)).toEqual(sent);
  });

  it('string format collapses an array message to its raw_message', () => {
    const msg = { post_type: 'message', message: [{ type: 'text', data: { text: 'hi' } }], raw_message: 'hi' } as JsonObject;
    expect(shapeEventForAdapter(msg, arrayOpts)).toEqual(msg);          // untouched in array mode
    const shaped = shapeEventForAdapter(msg, stringOpts);
    expect(shaped?.message).toBe('hi');                                  // array → raw string
  });
});

describe('WsClientAdapter — bootstrap meta on open (characterization)', () => {
  beforeEach(() => { clientInstances.length = 0; });

  function cfg(over: Partial<WsClientNetwork> = {}): WsClientNetwork {
    return { enabled: true, url: 'ws://127.0.0.1:8080/', role: 'Universal', reconnectIntervalMs: 1000, ...over } as WsClientNetwork;
  }

  it('sends exactly [connect, enable, heartbeat] when the socket opens', () => {
    const adapter = new WsClientAdapter('ws', cfg(), ctx());
    adapter.open();
    clientInstances[0].simulateOpen();

    const frames = clientInstances[0].sent.map(parse);
    expect(frames).toEqual([
      { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'connect' },
      { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'enable' },
      { post_type: 'meta_event', meta_event_type: 'heartbeat', interval: 5000 },
    ]);
  });

  it('does NOT send bootstrap when role is Api-only', () => {
    const adapter = new WsClientAdapter('ws', cfg({ role: 'Api' }), ctx());
    adapter.open();
    clientInstances[0].simulateOpen();
    expect(clientInstances[0].sent).toEqual([]);
  });

  it('drops a bootstrap frame that shapes to null, and threads options through the shaper', () => {
    // Force the heartbeat to shape to null when reportSelfMessage is false by
    // making it a message_sent event. This pins TWO invariants the lift must
    // keep: (1) a frame whose shape returns null is skipped, (2) the adapter's
    // options actually reach shapeEventForAdapter (else the drop wouldn't be
    // conditional on reportSelfMessage).
    const selfMsgHeartbeatCtx = (): NetworkAdapterContext => ({
      ...ctx(),
      buildHeartbeatEvent: () => ({ post_type: 'message_sent', message: [{ type: 'text', data: { text: 'x' } }], raw_message: 'x' }),
    });

    const dropper = new WsClientAdapter('ws', cfg({ reportSelfMessage: false }), selfMsgHeartbeatCtx());
    dropper.open();
    clientInstances.at(-1)!.simulateOpen();
    expect(clientInstances.at(-1)!.sent.map(parse).map((f) => f.sub_type)).toEqual(['connect', 'enable']);

    clientInstances.length = 0;
    const keeper = new WsClientAdapter('ws', cfg({ reportSelfMessage: true }), selfMsgHeartbeatCtx());
    keeper.open();
    clientInstances.at(-1)!.simulateOpen();
    expect(clientInstances.at(-1)!.sent).toHaveLength(3); // kept when self-reporting → options threaded
  });
});

describe('WsServerAdapter — bootstrap on connect + disable on close (characterization)', () => {
  beforeEach(() => { servers.length = 0; clientInstances.length = 0; });

  function cfg(over: Partial<WsServerNetwork> = {}): WsServerNetwork {
    return { enabled: true, host: '127.0.0.1', port: 8080, path: '/', role: 'Event', accessToken: '', ...over } as WsServerNetwork;
  }
  const req = { headers: {}, url: '/' };

  it('sends the bootstrap triplet to a new Event connection', () => {
    const adapter = new WsServerAdapter('wss', cfg(), ctx());
    adapter.open();
    const sock = new FakeWebSocket();
    servers[0].simulateConnection(sock, req);

    const frames = sock.sent.map(parse);
    expect(frames.map((f) => f.meta_event_type)).toEqual(['lifecycle', 'lifecycle', 'heartbeat']);
    expect(frames.map((f) => f.sub_type)).toEqual(['connect', 'enable', undefined]);
  });

  it('broadcasts a single disable lifecycle to connected event clients on close()', () => {
    const adapter = new WsServerAdapter('wss', cfg(), ctx());
    adapter.open();
    const sock = new FakeWebSocket();
    servers[0].simulateConnection(sock, req);
    sock.sent.length = 0; // drop the bootstrap frames; we only care about close

    adapter.close();

    const frames = sock.sent.map(parse);
    expect(frames).toEqual([
      { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disable' },
    ]);
  });

  it('skips Api connections for both bootstrap and the close disable broadcast', () => {
    // Role is classified per request path (no fixed config.role): /event → Event,
    // /api → Api. Pins that Api conns receive neither the bootstrap triplet nor
    // the disable broadcast — the close()-side Api guard the lift reroutes.
    const adapter = new WsServerAdapter('wss', cfg({ role: undefined }), ctx());
    adapter.open();
    const eventSock = new FakeWebSocket();
    const apiSock = new FakeWebSocket();
    servers[0].simulateConnection(eventSock, { headers: {}, url: '/event' });
    servers[0].simulateConnection(apiSock, { headers: {}, url: '/api' });

    expect(apiSock.sent).toEqual([]);        // Api gets no bootstrap
    expect(eventSock.sent).toHaveLength(3);  // Event gets the triplet
    eventSock.sent.length = 0;

    adapter.close();

    expect(apiSock.sent).toEqual([]);        // Api skipped on close too
    expect(eventSock.sent.map(parse)).toEqual([
      { post_type: 'meta_event', meta_event_type: 'lifecycle', sub_type: 'disable' },
    ]);
  });
});
