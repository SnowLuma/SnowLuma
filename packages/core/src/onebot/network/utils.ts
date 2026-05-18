// Helpers shared between OneBot network adapters.

import type { IncomingMessage } from 'http';
import type { WebSocket } from '@snowluma/websocket';

/** Validate a request's bearer token / `?access_token=` query against the configured token. */
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

/** Best-effort send: drops payload if the socket isn't OPEN, reports send errors. */
export function safeSend(socket: WebSocket, payload: string, onError?: (err: Error) => void): void {
  if (socket.readyState !== 1 /* WebSocket.OPEN */) return;
  socket.send(payload, (error?: Error | null) => {
    if (error && onError) onError(error);
  });
}

/** Best-effort close, treats already-closed sockets as a no-op. */
export function safeClose(socket: WebSocket, code = 1000, reason = 'normal'): void {
  if (socket.readyState === 3 /* CLOSED */ || socket.readyState === 2 /* CLOSING */) return;
  socket.close(code, reason);
}

/** Normalize an HTTP/WS path to a comparable form (strip trailing slash, default to "/"). */
export function normalizePath(pathValue: string | undefined): string {
  const path = (pathValue ?? '/').trim() || '/';
  if (path === '/') return '/';
  return path.endsWith('/') ? path.slice(0, -1) : path;
}

/** Parse the `pathname` from a (potentially relative) WebSocket request URL. */
export function parseRequestPath(urlValue: string): string {
  try {
    return new URL(urlValue, 'ws://127.0.0.1').pathname;
  } catch {
    return '/';
  }
}
