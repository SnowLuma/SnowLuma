import type {
  HighwayMsgInfoBody,
  HttpConn0x6FF501Request,
  HttpConn0x6FF501Response,
  NTV2IPv4,
  NTV2RichMediaHighwayExt,
  NTV2UploadRespMsgInfo,
  ReqDataHighwayHead,
  RespDataHighwayHead,
} from '@snowluma/proto-defs/highway';
import {
  createLogger,
  getLogLevel,
  renderTraceBytes,
  runWithTraceRequest,
} from '@snowluma/common/logger';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import net from 'net';
import { promises as fsp } from 'fs';
import type { BridgeContext } from '../bridge-context';
import { computeMd5, packHighwayFrame, unpackHighwayFrame } from './utils';

const log = createLogger('Highway');
const HIGHWAY_APP_ID = 1600001604;
const HIGHWAY_BLOCK_SIZE = 1024 * 1024;

// Per-chunk transport retry. A large file uploads as many sequential
// one-shot TCP connections; QQ's highway edge nodes (and proxies/NAT on the
// path) sporadically FIN a fresh connection before responding, so a single
// transient close among a 48 MB file's ~48 chunks must not abort the whole
// upload (issue #118). Only transport failures retry — a decoded highway
// error_code is a definitive server reject and is never retried.
const HIGHWAY_MAX_CHUNK_ATTEMPTS = 3;
const HIGHWAY_RETRY_BASE_MS = 300;

// Idle read timeout for a highway response. tcpConnect() clears the socket's
// own timeout once connected, so a peer that accepts the connection but then
// neither responds nor FINs would hang the whole upload forever. The single
// persistent connection (issue #211) keeps a socket alive across the whole
// file, widening that exposure, so the response reader arms its own idle timer
// and treats a stall as a retryable transport failure.
const HIGHWAY_READ_IDLE_MS = 30000;

const sleepMs = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

export const PRIVATE_IMAGE_CMD_ID = 1003;
export const GROUP_IMAGE_CMD_ID = 1004;

export interface HighwaySession {
  sigSession: Uint8Array;
  sessionKey: Uint8Array;
  host: string;
  port: number;
}

function ipv4ToString(value: number): string {
  return `${value & 0xFF}.${(value >> 8) & 0xFF}.${(value >> 16) & 0xFF}.${(value >> 24) & 0xFF}`;
}

type HighwayPutFailureReason =
  | 'control_decode_failed'
  | 'server_rejected'
  | 'source_close_failed'
  | 'source_read_failed'
  | 'transport_exhausted';

interface HighwayPutTraceState {
  startedAt: number;
  uploadedBytes: number;
  connectCount: number;
  failureReason?: HighwayPutFailureReason;
  error?: unknown;
}

class HighwayResponseReadError extends Error {
  constructor(message: string, readonly responseBody?: Uint8Array) {
    super(message);
    this.name = 'HighwayResponseReadError';
  }
}

function highwayErrorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export function fetchHighwaySession(bridge: BridgeContext): Promise<HighwaySession> {
  const startedAt = Date.now();
  return runWithTraceRequest(async () => {
    const request = protobuf_encode<HttpConn0x6FF501Request>({
      httpConn: {
        field1: 0, field2: 0, field3: 16, field4: 1, field6: 3,
        serviceTypes: [1, 5, 10, 21],
        field9: 2, field10: 9, field11: 8, ver: '1.0.1',
      },
    });
    log.trace(
      'highway_session_start serviceCmd=%j requestBytes=%d',
      'HttpConn.0x6ff_501',
      request.byteLength,
    );

    let failureReason = 'request_failed';
    try {
      const result = await bridge.sendRawPacket('HttpConn.0x6ff_501', request);
      log.trace(
        'highway_session_branch branch=control_response success=%s gotResponse=%s errorCode=%d errorMessage=%j responseBytes=%d',
        result.success,
        result.gotResponse,
        result.errorCode,
        result.errorMessage ?? '',
        result.responseData?.byteLength ?? 0,
      );
      if (!result.success || !result.gotResponse || !result.responseData) {
        throw new Error(result.errorMessage || 'HttpConn request failed');
      }

      failureReason = 'response_decode_failed';
      const resp = protobuf_decode<HttpConn0x6FF501Response>(result.responseData);
      failureReason = 'response_invalid';
      if (!resp?.httpConn) throw new Error('HttpConn response body missing');
      if (!resp.httpConn.sigSession || (resp.httpConn.sigSession as Uint8Array).length === 0) {
        throw new Error('HttpConn response missing sig_session');
      }

      const session: HighwaySession = {
        sigSession: resp.httpConn.sigSession as Uint8Array,
        sessionKey: (resp.httpConn.sessionKey as Uint8Array) ?? new Uint8Array(0),
        host: 'htdata3.qq.com',
        port: 80,
      };

      for (const si of resp.httpConn.serverInfos ?? []) {
        if ((si.serviceType ?? 0) !== 1 || !si.serverAddrs?.length) continue;
        for (const addr of si.serverAddrs) {
          const ip = addr.ip ?? 0;
          const port = addr.port ?? 0;
          if (ip && port) {
            session.host = ipv4ToString(ip);
            session.port = port;
          }
        }
      }

      log.trace(
        'highway_session_terminal outcome=completed reason=session_ready host=%j port=%d sigBytes=%d sessionKeyBytes=%d elapsedMs=%d',
        session.host,
        session.port,
        session.sigSession.byteLength,
        session.sessionKey.byteLength,
        Date.now() - startedAt,
      );
      return session;
    } catch (error) {
      log.trace(() => [
        'highway_session_terminal outcome=failed reason=%s error=%j elapsedMs=%d',
        failureReason,
        highwayErrorText(error),
        Date.now() - startedAt,
      ]);
      throw error;
    }
  });
}

function makeHighwayHead(
  uin: string, commandId: number, fileSize: number, offset: number, length: number,
  chunkMd5: Uint8Array, fileMd5: Uint8Array, sigSession: Uint8Array, extend: Uint8Array,
): Uint8Array {
  return protobuf_encode<ReqDataHighwayHead>({
    msgBaseHead: {
      version: 1, uin, command: 'PicUp.DataUp', seq: 0, retryTimes: 0,
      appId: HIGHWAY_APP_ID, dataFlag: 16, commandId,
    },
    msgSegHead: {
      serviceId: 0, filesize: BigInt(fileSize), dataOffset: BigInt(offset), dataLength: length,
      retCode: 0, serviceTicket: sigSession, flag: 0, md5: chunkMd5, fileMd5, cacheAddr: 0, cachePort: 0,
    },
    bytesReqExtendInfo: extend,
    timestamp: 0n,
    msgLoginSigHead: { loginSigType: 8, appId: HIGHWAY_APP_ID },
  });
}

export function buildHighwayExtend(
  uKey: string,
  msgInfo: NTV2UploadRespMsgInfo,
  ipv4s: NTV2IPv4[],
  sha1: Uint8Array | Uint8Array[],
  fileIndex = 0,
): Uint8Array {
  const msgInfoBody = msgInfo?.msgInfoBody ?? [];
  if (msgInfoBody.length === 0) throw new Error('upload response missing msg_info body');

  const selected = msgInfoBody[fileIndex] ?? msgInfoBody[0];
  const networkIpv4s: NonNullable<NonNullable<NTV2RichMediaHighwayExt['network']>['ipv4s']> = [];
  for (const ipv4 of ipv4s ?? []) {
    const ip = ipv4.outIp ?? 0;
    const port = ipv4.outPort ?? 0;
    if (ip && port) {
      networkIpv4s.push({ domain: { isEnable: true, ip: ipv4ToString(ip) }, port });
    }
  }

  return protobuf_encode<NTV2RichMediaHighwayExt>({
    fileUuid: selected?.index?.fileUuid ?? '',
    uKey,
    network: { ipv4s: networkIpv4s },
    msgInfoBody: msgInfoBody.map((b: HighwayMsgInfoBody) => ({
      index: b.index, picture: b.picture, fileExist: b.fileExist, hashSum: b.hashSum,
    })),
    blockSize: HIGHWAY_BLOCK_SIZE,
    hash: { fileSha1: Array.isArray(sha1) ? sha1 : [sha1] },
  });
}

// --- TCP-based HTTP highway upload ---

function tcpConnect(host: string, port: number, timeoutMs = 10000): Promise<net.Socket> {
  return new Promise((resolve, reject) => {
    let settled = false;
    const onTimeout = () => {
      if (settled) return;
      settled = true;
      socket.destroy();
      reject(new Error('TCP connect timeout'));
    };
    const onError = (err: Error) => {
      if (settled) return;
      settled = true;
      reject(err);
    };
    const socket = net.createConnection({ host, port }, () => {
      if (settled) return;
      settled = true;
      // Drop the connect-only listeners so subsequent IO errors / idle
      // timeouts don't try to reject this already-resolved promise.
      socket.setTimeout(0);
      socket.removeListener('timeout', onTimeout);
      socket.removeListener('error', onError);
      resolve(socket);
    });
    socket.setTimeout(timeoutMs);
    socket.once('timeout', onTimeout);
    socket.once('error', onError);
  });
}

function socketWrite(socket: net.Socket, data: Uint8Array): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.write(data, (err) => err ? reject(err) : resolve());
  });
}

function readHttpResponseBody(socket: net.Socket): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let headerEnd = -1;
    let contentLength = 0;
    let totalNeeded = 0;
    let settled = false;

    const partialResponseBody = (): Uint8Array | undefined => {
      if (headerEnd < 0 || getLogLevel() !== 'trace') return undefined;
      const buf = Buffer.concat(chunks);
      return new Uint8Array(buf.subarray(headerEnd));
    };

    // Reset on every inbound chunk; fire if the peer goes silent mid-response.
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const armIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(
        () => finish(() => reject(new HighwayResponseReadError(
          'highway response read timeout (peer idle)',
          partialResponseBody(),
        ))),
        HIGHWAY_READ_IDLE_MS,
      );
    };

    const detach = () => {
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      socket.off('data', onData);
      socket.off('error', onError);
      socket.off('close', onClose);
    };
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      detach();
      fn();
    };
    const onData = (chunk: Buffer) => {
      armIdle();
      chunks.push(chunk);
      const buf = Buffer.concat(chunks);
      if (headerEnd < 0) {
        const idx = buf.indexOf('\r\n\r\n');
        if (idx >= 0) {
          headerEnd = idx + 4;
          const headerStr = buf.subarray(0, headerEnd).toString('ascii').toLowerCase();
          const clMatch = headerStr.match(/content-length:\s*(\d+)/);
          contentLength = clMatch ? parseInt(clMatch[1], 10) : 0;
          totalNeeded = headerEnd + contentLength;
        }
      }
      if (headerEnd >= 0 && buf.length >= totalNeeded) {
        finish(() => resolve(new Uint8Array(buf.subarray(headerEnd, totalNeeded))));
      }
    };
    const onError = (err: Error) => finish(() => {
      const responseBody = partialResponseBody();
      reject(responseBody === undefined
        ? err
        : new HighwayResponseReadError(err.message, responseBody));
    });
    const onClose = () => finish(() => {
      const buf = Buffer.concat(chunks);
      // A fully-received body would already have resolved in onData; reaching
      // here means the peer FIN'd before the response completed. Only a
      // close-delimited body (no Content-Length) is legitimately ended by the
      // FIN — resolve that. A declared-but-unmet Content-Length, or a
      // half-received header, is a TRUNCATED response: reject it as a
      // retryable transport failure so the caller's attempt loop reconnects
      // and re-sends this block, instead of resolving a partial frame that
      // unpackHighwayFrame would fatally reject OUTSIDE that loop (turning a
      // recoverable mid-body FIN into a failed upload).
      //
      // QQ 的 highway 边缘节点对单连接多 POST 的 keep-alive 支持不稳定，常在
      // 响应后立刻 FIN；诊断信息带上已收字节数、是否见到 header、需要多少，
      // 便于区分 “连接刚握手就被关” 和 “响应读到一半被截断”。
      if (headerEnd >= 0 && contentLength === 0) {
        resolve(new Uint8Array(buf.subarray(headerEnd)));
      } else {
        reject(new HighwayResponseReadError(
          `connection closed before full response (received=${buf.length}B, ` +
          `headerSeen=${headerEnd >= 0}${headerEnd >= 0 ? `, need=${totalNeeded}` : ''})`,
          headerEnd >= 0 && getLogLevel() === 'trace'
            ? new Uint8Array(buf.subarray(headerEnd))
            : undefined,
        ));
      }
    });

    armIdle();
    socket.on('data', onData);
    socket.on('error', onError);
    socket.on('close', onClose);
  });
}

async function httpPostFrame(
  socket: net.Socket, host: string, path: string, body: Uint8Array,
): Promise<Uint8Array> {
  const header = `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\nAccept-Encoding: identity\r\nUser-Agent: Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)\r\nContent-Length: ${body.length}\r\n\r\n`;
  await socketWrite(socket, Buffer.from(header, 'ascii'));
  if (body.length > 0) await socketWrite(socket, body);
  return readHttpResponseBody(socket);
}

// ─────────────── ChunkSource: buffer-or-disk input for highway PUTs ───────────────

/**
 * Abstracts where the upload bytes come from so `uploadHighwayHttp` can PUT
 * either an in-memory buffer (image / ptt / thumb / avatar — small) or a file
 * on disk (large video / group file — streamed 1 MiB at a time, never fully
 * buffered). `read(offset, length)` MUST return exactly `length` bytes. The
 * uploader owns the source and calls `close()` exactly once.
 */
export interface ChunkSource {
  readonly size: number;
  read(offset: number, length: number): Promise<Uint8Array>;
  close(): Promise<void>;
}

/** In-memory source — byte-for-byte the pre-refactor behavior. `close()` no-op. */
export class BufferChunkSource implements ChunkSource {
  constructor(private readonly bytes: Uint8Array) {}
  get size(): number { return this.bytes.length; }
  read(offset: number, length: number): Promise<Uint8Array> {
    return Promise.resolve(this.bytes.subarray(offset, offset + length));
  }
  close(): Promise<void> { return Promise.resolve(); }
}

/**
 * Disk-backed source. Reads from an open `FileHandle` at explicit offsets, so a
 * multi-GiB upload never holds more than one chunk in memory. `read` loops until
 * it has exactly `length` bytes — `FileHandle.read` may legally short-read — and
 * throws on unexpected EOF (callers only ever request ranges within `size`).
 */
export class FileChunkSource implements ChunkSource {
  private constructor(private readonly fh: fsp.FileHandle, readonly size: number) {}

  static async open(filePath: string, size: number): Promise<FileChunkSource> {
    const fh = await fsp.open(filePath, 'r');
    return new FileChunkSource(fh, size);
  }

  async read(offset: number, length: number): Promise<Uint8Array> {
    const buf = Buffer.allocUnsafe(length);
    let got = 0;
    while (got < length) {
      const { bytesRead } = await this.fh.read(buf, got, length - got, offset + got);
      if (bytesRead === 0) {
        throw new Error(
          `FileChunkSource: unexpected EOF at ${offset + got} ` +
          `(wanted ${length}, got ${got}, size=${this.size})`,
        );
      }
      got += bytesRead;
    }
    return buf;
  }

  close(): Promise<void> { return this.fh.close(); }
}

export function uploadHighwayHttp(
  bridge: BridgeContext, session: HighwaySession, commandId: number,
  source: ChunkSource, fileMd5: Uint8Array, extend: Uint8Array,
): Promise<void> {
  const state: HighwayPutTraceState = {
    startedAt: Date.now(),
    uploadedBytes: 0,
    connectCount: 0,
  };
  return runWithTraceRequest(async () => {
    log.trace(() => [
      'highway_put_start cmdId=%d uin=%j host=%j port=%d totalBytes=%d fileMd5=%s extendBytes=%d',
      commandId,
      bridge.identity.uin,
      session.host,
      session.port,
      source.size,
      renderTraceBytes(fileMd5),
      extend.byteLength,
    ]);
    try {
      await uploadHighwayHttpOperation(
        bridge,
        session,
        commandId,
        source,
        fileMd5,
        extend,
        state,
      );
      log.trace(
        'highway_put_terminal cmdId=%d outcome=completed reason=upload_complete totalBytes=%d uploadedBytes=%d connections=%d elapsedMs=%d',
        commandId,
        source.size,
        state.uploadedBytes,
        state.connectCount,
        Date.now() - state.startedAt,
      );
    } catch (error) {
      log.trace(() => [
        'highway_put_terminal cmdId=%d outcome=failed reason=%s totalBytes=%d uploadedBytes=%d connections=%d error=%j elapsedMs=%d',
        commandId,
        state.failureReason ?? 'unexpected_failure',
        source.size,
        state.uploadedBytes,
        state.connectCount,
        highwayErrorText(state.error ?? error),
        Date.now() - state.startedAt,
      ]);
      throw error;
    }
  });
}

async function uploadHighwayHttpOperation(
  bridge: BridgeContext, session: HighwaySession, commandId: number,
  source: ChunkSource, fileMd5: Uint8Array, extend: Uint8Array,
  trace: HighwayPutTraceState,
): Promise<void> {
  const pathStr = `/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${bridge.identity.uin}`;
  const totalSize = source.size;

  // Single-connection, in-order, pipelined upload (issue #211).
  //
  // Blocks are PUT in STRICT offset order over ONE persistent connection,
  // reused across chunks via HTTP keep-alive. Two properties matter:
  //   - In order: QQ's highway server reassembles by offset but REJECTS a
  //     block that arrives after a later one (error_code=102902) — parallel or
  //     out-of-order PUTs do not work (proven on a real endpoint). Sequential
  //     send guarantees in-order arrival.
  //   - One warm connection: reusing the socket keeps the TCP congestion
  //     window open across the whole file instead of paying slow-start on a
  //     fresh connection for every 1 MiB block. That per-block cold start was
  //     the real throughput cap behind #211.
  //
  // QQ's edge nodes (and proxies/NAT on the path) sometimes FIN between
  // chunks — that is what forced the one-connection-per-chunk workaround in
  // #118. We handle it adaptively: if reusing the socket fails, or the peer
  // half-closed after a response, we drop it, reconnect, and re-send the SAME
  // block (re-PUTting an offset is idempotent). Worst case — a server that
  // closes after every response — degrades to one connection per block: no
  // worse than the #118 behavior, and still strictly in order (so never
  // error_code=102902). `connectCount` is logged so a real run reveals which
  // regime we hit (1 connection = keep-alive honored; ~chunkCount = closed
  // every time).
  //
  // `source` may buffer the whole file (BufferChunkSource) or stream it from
  // disk (FileChunkSource); either way one chunk is read/held at a time. We
  // own the source and close it exactly once in the `finally` below.
  let succeeded = false;
  let sourceCloseFailure: { error: unknown } | undefined;
  let socket: net.Socket | null = null;
  let connectCount = 0;
  const dropSocket = (): void => {
    if (socket) { socket.destroy(); socket = null; }
  };
  try {
    let offset = 0;
    while (offset < totalSize) {
      const chunkSize = Math.min(HIGHWAY_BLOCK_SIZE, totalSize - offset);
      let chunk: Uint8Array;
      try {
        chunk = await source.read(offset, chunkSize);
      } catch (error) {
        trace.failureReason = 'source_read_failed';
        trace.error = error;
        throw error;
      }
      log.trace('highway_put_branch branch=chunk_read offset=%d bytes=%d', offset, chunkSize);
      const chunkMd5 = computeMd5(chunk);
      const head = makeHighwayHead(
        bridge.identity.uin, commandId, totalSize, offset, chunkSize,
        chunkMd5, fileMd5, session.sigSession, extend,
      );
      log.trace(() => [
        'highway_put_branch branch=chunk_control_request offset=%d bytes=%d headBytes=%d headHex=%s',
        offset,
        chunkSize,
        head.byteLength,
        renderTraceBytes(head),
      ]);
      const frame = packHighwayFrame(head, chunk);

      // Send this block, reusing the live connection when there is one. On any
      // transport failure (peer FIN between chunks, ECONNRESET, connect
      // refused/timeout) drop the socket, reconnect, and retry THIS block —
      // re-sending the same offset range is idempotent on the server.
      let responseBody: Uint8Array | undefined;
      for (let attempt = 1; ; attempt++) {
        try {
          if (!socket) {
            socket = await tcpConnect(session.host, session.port);
            connectCount += 1;
            trace.connectCount = connectCount;
            log.trace(
              'highway_put_branch branch=%s offset=%d attempt=%d connection=%d',
              connectCount === 1 ? 'connect' : 'reconnect',
              offset,
              attempt,
              connectCount,
            );
          }
          log.trace(
            'highway_put_branch branch=chunk_attempt offset=%d bytes=%d attempt=%d connection=%d',
            offset,
            chunkSize,
            attempt,
            connectCount,
          );
          responseBody = await httpPostFrame(socket, session.host, pathStr, frame);
          break;
        } catch (err) {
          if (err instanceof HighwayResponseReadError && err.responseBody) {
            log.trace(() => [
              'highway_put_branch branch=chunk_control_response_partial offset=%d attempt=%d responseBytes=%d responseHex=%s',
              offset,
              attempt,
              err.responseBody!.byteLength,
              renderTraceBytes(err.responseBody!),
            ]);
          }
          dropSocket();
          if (attempt >= HIGHWAY_MAX_CHUNK_ATTEMPTS) {
            trace.failureReason = 'transport_exhausted';
            const exhausted = new Error(
              `highway upload transport failed after ${attempt} attempts ` +
              `(cmdId=${commandId} chunk=${chunkSize}/${totalSize} offset=${offset}): ${String(err)}`,
            );
            trace.error = exhausted;
            throw exhausted;
          }
          log.trace(
            'highway_put_branch branch=chunk_retry offset=%d bytes=%d attempt=%d error=%j',
            offset,
            chunkSize,
            attempt,
            highwayErrorText(err),
          );
          await sleepMs(HIGHWAY_RETRY_BASE_MS * attempt);
        }
      }

      // Unreachable: the retry loop only exits via break (responseBody set) or
      // throw — the guard just narrows the type for the compiler.
      if (!responseBody) {
        trace.failureReason = 'transport_exhausted';
        trace.error = new Error('highway upload: missing response');
        throw trace.error;
      }
      log.trace(() => [
        'highway_put_branch branch=chunk_control_response offset=%d bytes=%d responseBytes=%d responseHex=%s',
        offset,
        chunkSize,
        responseBody.byteLength,
        renderTraceBytes(responseBody),
      ]);
      let resp: RespDataHighwayHead;
      try {
        const { head: respHead } = unpackHighwayFrame(responseBody);
        resp = protobuf_decode<RespDataHighwayHead>(respHead);
        log.trace(
          'highway_put_branch branch=chunk_control_decoded offset=%d errorCode=%d segRetCode=%d',
          offset,
          resp?.errorCode ?? 0,
          resp?.msgSegHead?.retCode ?? 0,
        );
      } catch (error) {
        trace.failureReason = 'control_decode_failed';
        trace.error = error;
        throw error;
      }
      if (resp?.errorCode && resp.errorCode !== 0) {
        // Surface every diagnostic the highway response carries so
        // user reports of `error_code=921` and friends include the
        // server-side context (segHead.retCode, chunk size, file md5)
        // — without these we can't tell apart a malformed-payload
        // reject, a session-ticket mismatch, or a per-account rate-
        // limit.
        const segRetCode = resp.msgSegHead?.retCode ?? 0;
        const fileMd5Hex = Buffer.from(fileMd5).toString('hex');
        trace.failureReason = 'server_rejected';
        trace.error = new Error(
          `highway upload error_code=${resp.errorCode}` +
          ` (cmdId=${commandId} chunk=${chunkSize}/${totalSize}` +
          ` offset=${offset} segRetCode=${segRetCode}` +
          ` fileMd5=${fileMd5Hex.slice(0, 16)}…)`,
        );
        throw trace.error;
      }

      // If the peer half-closed after sending its response, the socket can no
      // longer carry the next block — drop it now so the next iteration
      // reconnects cleanly instead of writing into a dead socket.
      if (socket && (socket.destroyed || socket.readableEnded || !socket.writable)) {
        dropSocket();
      }

      offset += chunkSize;
      trace.uploadedBytes = offset;
      log.trace(
        'highway_put_branch branch=chunk_completed offset=%d totalBytes=%d',
        offset,
        totalSize,
      );
    }
    succeeded = true;
    if (totalSize > 0) {
      log.debug('highway upload done: %d bytes over %d connection(s) (cmdId=%d)',
        totalSize, connectCount, commandId);
    }
  } finally {
    // Best-effort close — never mask a primary upload error. A close failure
    // is only surfaced when the upload itself succeeded.
    dropSocket();
    try {
      await source.close();
    } catch (closeErr) {
      if (succeeded) {
        sourceCloseFailure = { error: closeErr };
      }
    }
  }
  if (sourceCloseFailure) {
    trace.failureReason = 'source_close_failed';
    trace.error = sourceCloseFailure.error;
    throw sourceCloseFailure.error;
  }
}
