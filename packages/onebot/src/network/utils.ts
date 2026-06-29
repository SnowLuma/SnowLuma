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
 *  Never rejects — a closed socket or send error resolves quietly (the stream
 *  sink handles liveness/abort separately so a dead client can't crash the
 *  per-message handler with an unhandled rejection). */
export function safeSendAsync(socket: WebSocket, payload: string): Promise<void> {
  return new Promise((resolve) => {
    if (socket.readyState !== 1 /* WebSocket.OPEN */) { resolve(); return; }
    socket.send(payload, () => resolve());
  });
}

export function safeClose(socket: WebSocket, code = 1000, reason = 'normal'): void {
  if (socket.readyState === 3 /* CLOSED */ || socket.readyState === 2 /* CLOSING */) return;
  socket.close(code, reason);
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
