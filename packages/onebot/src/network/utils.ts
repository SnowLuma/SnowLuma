import { StreamTransportClosedError } from '../streaming';
import type { WebSocket } from '@snowluma/websocket';
import type { IncomingMessage } from 'http';

export function isAuthorized(request: IncomingMessage, token: string): boolean {
  if (!token) return true;
  const auth = request.headers.authorization ?? '';
  if (auth === `Bearer ${token}`) return true;
  try {
    const url = new URL(request.url ?? '/', 'http://127.0.0.1');
    if (url.searchParams.get('access_token') === token) return true;
  } catch { /* ignore malformed URLs */ }
  return false;
}

/** Convert anything ws can hand us into a UTF-8 string. */
export function rawDataToString(raw: Buffer | string | ArrayBuffer | ArrayBufferView | Buffer[]): string {
  if (typeof raw === 'string') return raw;
  if (Buffer.isBuffer(raw)) return raw.toString('utf8');
  if (Array.isArray(raw)) return Buffer.concat(raw).toString('utf8');
  if (raw instanceof ArrayBuffer) return Buffer.from(new Uint8Array(raw)).toString('utf8');
  if (ArrayBuffer.isView(raw)) {
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8');
  }
  return '';
}

export function safeSend(socket: WebSocket, payload: string, onError?: (err: Error) => void): void {
  if (socket.readyState !== 1 /* WebSocket.OPEN */) return;
  socket.send(payload, (error?: Error | null) => {
    if (error && onError) onError(error);
  });
}

/** Backpressure-aware send: resolves only once `ws` has flushed `payload` to
 *  the socket (the `send` callback fires post-write), so a streaming producer
 *  that awaits this won't outrun a slow client and balloon the send buffer.
 *  A closed socket or failed write rejects with the shared transport sentinel,
 *  allowing the action boundary to classify an in-progress stream cancellation. */
export function safeSendAsync(socket: WebSocket, payload: string): Promise<void> {
  return new Promise((resolve, reject) => {
    if (socket.readyState !== 1 /* WebSocket.OPEN */) {
      reject(new StreamTransportClosedError('stream client disconnected'));
      return;
    }
    try {
      socket.send(payload, (error?: Error | null) => {
        if (error) {
          reject(new StreamTransportClosedError('stream client disconnected'));
          return;
        }
        resolve();
      });
    } catch {
      reject(new StreamTransportClosedError('stream client disconnected'));
    }
  });
}

export function safeClose(socket: WebSocket, code = 1000, reason = 'normal'): void {
  if (socket.readyState === 3 /* CLOSED */ || socket.readyState === 2 /* CLOSING */) return;
  socket.close(code, reason);
}

/** RFC6455 transport-level keepalive for a reverse-WS connection.
 *
 *  The OneBot app-level `meta_event` heartbeat is a one-way outbound push, so it
 *  cannot detect a connection that is writable but no longer readable — a
 *  half-open link left behind when the peer restarts behind a proxy/NAT. In that
 *  state events keep flowing out while inbound action frames silently never
 *  arrive, and only a full restart recovers it (issue #208).
 *
 *  This pings every `intervalMs` and counts consecutive silent intervals. ANY
 *  inbound activity — a pong OR a message — resets the counter, so a connection
 *  carrying real traffic is never reaped. Death is declared once `maxMissed`
 *  pings have gone unanswered, i.e. after roughly `(maxMissed + 1) * intervalMs`
 *  of total silence (the counter is checked at the top of each tick, so the
 *  tick that observes the threshold is one interval past the last ping). The
 *  tolerance plus a conservative interval keeps the false-positive rate near
 *  zero: a single GC pause, event-loop stall, or transient latency spike is
 *  absorbed (Node fires an overdue interval once, not N catch-up times), and
 *  death is declared only on genuine sustained silence.
 *
 *  Returns an idempotent stop function; the timer is `unref`'d so it never keeps
 *  the process alive. */
export function startHeartbeat(
  socket: WebSocket,
  opts: { intervalMs: number; maxMissed: number },
  onDead: () => void,
): () => void {
  let missed = 0;
  let stopped = false;
  const onActivity = (): void => { missed = 0; };
  socket.on('pong', onActivity);
  socket.on('message', onActivity);

  const timer = setInterval(() => {
    if (missed >= opts.maxMissed) {
      // `maxMissed` consecutive intervals with zero inbound traffic — the read
      // direction is dead. Stop first so onDead()'s terminate→close→reconnect
      // can't re-enter this tick.
      stop();
      onDead();
      return;
    }
    missed += 1;
    try {
      socket.ping();
    } catch {
      // Ping on an already-dead socket — treat as dead immediately.
      stop();
      onDead();
    }
  }, opts.intervalMs);
  timer.unref?.();

  function stop(): void {
    if (stopped) return;
    stopped = true;
    clearInterval(timer);
    socket.off?.('pong', onActivity);
    socket.off?.('message', onActivity);
  }
  return stop;
}

export function normalizePath(pathValue: string | undefined): string {
  const path = (pathValue ?? '/').trim() || '/';
  if (path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

export function parseRequestPath(urlValue: string): string {
  try {
    return new URL(urlValue, 'ws://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}
