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
import { validateUploadConcurrency } from './upload-settings';
import { computeMd5, packHighwayFrame, unpackHighwayFrame } from './utils';

const log = createLogger('Highway');
const HIGHWAY_APP_ID = 1600001604;
const HIGHWAY_BLOCK_SIZE = 1024 * 1024;
const HIGHWAY_CONNECT_TIMEOUT_MS = 3000;
const HIGHWAY_CONNECT_BUDGET_MS = 10000;

// Per-chunk transport retry: a transient connection failure retries only
// the unconfirmed offset, preserving acknowledged data (issue #118).
// Most decoded highway
// error_codes are definitive rejects and are never retried — except
// 102902 / 302902, which QQ's own BDH client treats as NeedDelayRetry
// (issue #352; wrapper.node multi_uploader.cc).
const HIGHWAY_MAX_CHUNK_ATTEMPTS = 3;
const HIGHWAY_RETRY_BASE_MS = 300;
const HIGHWAY_DELAY_RETRY_CODES = new Set([102902, 302902]);
// Official DelayTryNext clamps server uDelayTime to [250, 1200] ms and
// gives up after 33 consecutive delay-retries. We don't currently parse
// uDelayTime out of the highway response, so use the 250 ms floor; 8
// consecutive delay-retries is enough to ride out the backpressure that
// #352 hits on multi-GiB PUTs without stalling a chunk for ~8 s.
const HIGHWAY_DELAY_RETRY_MS = 250;
const HIGHWAY_MAX_DELAY_RETRIES = 8;

// Idle read timeout for a highway response. tcpConnect() clears the socket's
// own timeout once connected, so a peer that accepts the connection but then
// neither responds nor FINs would hang the whole upload forever. The single
// persistent connection (issue #211) keeps a socket alive across the whole
// file, widening that exposure, so the response reader arms its own idle timer
// and treats a stall as a retryable transport failure.
const HIGHWAY_READ_IDLE_MS = 30000;

function sleepMs(ms: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const onAbort = () => {
            clearTimeout(timer);
            signal.removeEventListener('abort', onAbort);
            reject(signal.reason);
        };

        const timer = setTimeout(() => {
            signal.removeEventListener('abort', onAbort);
            resolve();
        }, ms);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

export const PRIVATE_IMAGE_CMD_ID = 1003;
export const GROUP_IMAGE_CMD_ID = 1004;

export interface HighwayServer {
    host: string;
    port: number;
}

export interface HighwaySession {
    sigSession: Uint8Array;
    sessionKey: Uint8Array;
    servers: HighwayServer[];
}

function ipv4ToString(value: number): string {
    return `${value & 0xff}.${(value >> 8) & 0xff}.${(value >> 16) & 0xff}.${(value >> 24) & 0xff}`;
}

type HighwayPutFailureReason =
    | 'invalid_options'
    | 'ack_mismatch'
    | 'connect_exhausted'
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
    constructor(
        message: string,
        readonly responseBody?: Uint8Array,
    ) {
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
                field1: 0,
                field2: 0,
                field3: 16,
                field4: 1,
                field6: 3,
                serviceTypes: [1, 5, 10, 21],
                field9: 2,
                field10: 9,
                field11: 8,
                ver: '1.0.1',
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

            if (!resp?.httpConn) {
                throw new Error('HttpConn response body missing');
            }

            if (
                !resp.httpConn.sigSession ||
                (resp.httpConn.sigSession as Uint8Array).length === 0
            ) {
                throw new Error('HttpConn response missing sig_session');
            }

            const session: HighwaySession = {
                sigSession: resp.httpConn.sigSession as Uint8Array,
                sessionKey: (resp.httpConn.sessionKey as Uint8Array) ?? new Uint8Array(0),
                servers: [],
            };
            const servers = new Map<string, HighwayServer>();

            for (const si of resp.httpConn.serverInfos ?? []) {
                if ((si.serviceType ?? 0) !== 1 || !si.serverAddrs?.length) {
                    continue;
                }

                for (const addr of si.serverAddrs) {
                    const ip = addr.ip ?? 0;
                    const port = addr.port ?? 0;

                    if (ip && port > 0 && port <= 65535) {
                        const host = ipv4ToString(ip);
                        servers.set(`${host}:${port}`, { host, port });
                    }
                }
            }

            session.servers = [...servers.values()];

            if (session.servers.length === 0) {
                throw new Error('HttpConn response has no upload servers');
            }

            log.trace(
                'highway_session_terminal outcome=completed reason=session_ready servers=%j sigBytes=%d sessionKeyBytes=%d elapsedMs=%d',
                session.servers,
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
    uin: string,
    commandId: number,
    fileSize: number,
    offset: number,
    length: number,
    chunkMd5: Uint8Array,
    fileMd5: Uint8Array,
    sigSession: Uint8Array,
    extend: Uint8Array,
    retryTimes = 0,
    sequence = 0,
): Uint8Array {
    return protobuf_encode<ReqDataHighwayHead>({
        msgBaseHead: {
            version: 1,
            uin,
            command: 'PicUp.DataUp',
            seq: sequence,
            retryTimes,
            appId: HIGHWAY_APP_ID,
            dataFlag: 16,
            commandId,
        },
        msgSegHead: {
            serviceId: 0,
            filesize: BigInt(fileSize),
            dataOffset: BigInt(offset),
            dataLength: length,
            retCode: 0,
            serviceTicket: sigSession,
            flag: 0,
            md5: chunkMd5,
            fileMd5,
            cacheAddr: 0,
            cachePort: 0,
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

    if (msgInfoBody.length === 0) {
        throw new Error('upload response missing msg_info body');
    }

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
            index: b.index,
            picture: b.picture,
            fileExist: b.fileExist,
            hashSum: b.hashSum,
        })),
        blockSize: HIGHWAY_BLOCK_SIZE,
        hash: { fileSha1: Array.isArray(sha1) ? sha1 : [sha1] },
    });
}

// --- TCP-based HTTP highway upload ---

function tcpConnect(
    host: string,
    port: number,
    timeoutMs: number,
    signal: AbortSignal,
): Promise<net.Socket> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        let settled = false;

        const cleanup = () => {
            socket.setTimeout(0);
            socket.removeListener('timeout', onTimeout);
            socket.removeListener('error', onError);
            signal.removeEventListener('abort', onAbort);
        };

        const fail = (error: unknown) => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            socket.destroy();
            reject(error);
        };

        const onTimeout = () => fail(new Error('TCP connect timeout'));
        const onError = (error: Error) => fail(error);
        const onAbort = () => fail(signal.reason);
        const socket = net.createConnection({ host, port }, () => {
            if (settled) {
                return;
            }

            settled = true;
            cleanup();
            resolve(socket);
        });
        socket.setTimeout(timeoutMs);
        socket.once('timeout', onTimeout);
        socket.once('error', onError);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function connectHighway(
    servers: HighwayServer[],
    startIndex: number,
    signal: AbortSignal,
): Promise<{ socket: net.Socket; server: HighwayServer; serverIndex: number }> {
    const deadline = Date.now() + HIGHWAY_CONNECT_BUDGET_MS;
    const errors: Error[] = [];

    for (let i = 0; i < servers.length; i++) {
        const serverIndex = (startIndex + i) % servers.length;
        const server = servers[serverIndex]!;
        const remaining = deadline - Date.now();

        if (remaining <= 0) {
            break;
        }

        try {
            const socket = await tcpConnect(
                server.host,
                server.port,
                Math.min(HIGHWAY_CONNECT_TIMEOUT_MS, remaining),
                signal,
            );
            return { socket, server, serverIndex };
        } catch (cause) {
            signal.throwIfAborted();
            const error = new Error(`${server.host}:${server.port}: ${highwayErrorText(cause)}`, {
                cause,
            });
            errors.push(error);
            log.debug('highway connect failed: %s', error.message);
        }
    }

    throw new AggregateError(
        errors,
        `highway upload connection failed: ${errors.map((error) => error.message).join('; ')}`,
    );
}

function socketWrite(socket: net.Socket, data: Uint8Array): Promise<void> {
    return new Promise((resolve, reject) => {
        socket.write(data, (err) => (err ? reject(err) : resolve()));
    });
}

function readHttpResponseBody(socket: net.Socket, signal: AbortSignal): Promise<Uint8Array> {
    signal.throwIfAborted();
    return new Promise((resolve, reject) => {
        const chunks: Buffer[] = [];
        let headerEnd = -1;
        let contentLength = 0;
        let totalNeeded = 0;
        let settled = false;

        const partialResponseBody = (): Uint8Array | undefined => {
            if (headerEnd < 0 || getLogLevel() !== 'trace') {
                return undefined;
            }

            const buf = Buffer.concat(chunks);
            return new Uint8Array(buf.subarray(headerEnd));
        };

        // Reset on every inbound chunk; fire if the peer goes silent mid-response.
        let idleTimer: ReturnType<typeof setTimeout> | null = null;

        const armIdle = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
            }

            idleTimer = setTimeout(
                () =>
                    finish(() =>
                        reject(
                            new HighwayResponseReadError(
                                'highway response read timeout (peer idle)',
                                partialResponseBody(),
                            ),
                        ),
                    ),
                HIGHWAY_READ_IDLE_MS,
            );
        };

        const detach = () => {
            if (idleTimer) {
                clearTimeout(idleTimer);
                idleTimer = null;
            }

            socket.off('data', onData);
            socket.off('error', onError);
            socket.off('close', onClose);
            signal.removeEventListener('abort', onAbort);
        };

        const finish = (fn: () => void) => {
            if (settled) {
                return;
            }

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

        const onAbort = () => finish(() => reject(signal.reason));
        const onError = (err: Error) =>
            finish(() => {
                const responseBody = partialResponseBody();
                reject(
                    responseBody === undefined
                        ? err
                        : new HighwayResponseReadError(err.message, responseBody),
                );
            });
        const onClose = () =>
            finish(() => {
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
                    reject(
                        new HighwayResponseReadError(
                            `connection closed before full response (received=${buf.length}B, ` +
                                `headerSeen=${headerEnd >= 0}${headerEnd >= 0 ? `, need=${totalNeeded}` : ''})`,
                            headerEnd >= 0 && getLogLevel() === 'trace'
                                ? new Uint8Array(buf.subarray(headerEnd))
                                : undefined,
                        ),
                    );
                }
            });

        armIdle();
        socket.on('data', onData);
        socket.on('error', onError);
        socket.on('close', onClose);
        signal.addEventListener('abort', onAbort, { once: true });
    });
}

async function httpPostFrame(
    socket: net.Socket,
    host: string,
    path: string,
    body: Uint8Array,
    signal: AbortSignal,
): Promise<Uint8Array> {
    const header = `POST ${path} HTTP/1.1\r\nHost: ${host}\r\nConnection: keep-alive\r\nAccept-Encoding: identity\r\nUser-Agent: Mozilla/5.0 (compatible; MSIE 10.0; Windows NT 6.2)\r\nContent-Length: ${body.length}\r\n\r\n`;
    const responseAbort = new AbortController();

    const onAbort = () => {
        responseAbort.abort(signal.reason);
        socket.destroy();
    };

    signal.throwIfAborted();
    signal.addEventListener('abort', onAbort, { once: true });
    // Arm the reader before writing: a fast peer may reply before write callbacks.
    const response = readHttpResponseBody(socket, responseAbort.signal);
    const write = (async () => {
        await socketWrite(socket, Buffer.from(header, 'ascii'));
        signal.throwIfAborted();

        if (body.length > 0) {
            await socketWrite(socket, body);
        }
    })();

    try {
        const [, result] = await Promise.all([write, response]);
        return result;
    } catch (error) {
        responseAbort.abort(error);
        socket.destroy();
        await Promise.allSettled([write, response]);
        throw error;
    } finally {
        signal.removeEventListener('abort', onAbort);
    }
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
    get size(): number {
        return this.bytes.length;
    }
    read(offset: number, length: number): Promise<Uint8Array> {
        return Promise.resolve(this.bytes.subarray(offset, offset + length));
    }
    close(): Promise<void> {
        return Promise.resolve();
    }
}

/**
 * Disk-backed source. Reads from an open `FileHandle` at explicit offsets, so a
 * multi-GiB upload never holds more than one chunk in memory. `read` loops until
 * it has exactly `length` bytes — `FileHandle.read` may legally short-read — and
 * throws on unexpected EOF (callers only ever request ranges within `size`).
 */
export class FileChunkSource implements ChunkSource {
    private constructor(
        private readonly fh: fsp.FileHandle,
        readonly size: number,
    ) {}

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

    close(): Promise<void> {
        return this.fh.close();
    }
}

export interface HighwayUploadOptions {
    /** One connection by default; two to four opt into bounded parallel chunks. */
    concurrency?: number;
}

export function uploadHighwayHttp(
    bridge: BridgeContext,
    session: HighwaySession,
    commandId: number,
    source: ChunkSource,
    fileMd5: Uint8Array,
    extend: Uint8Array,
    options: HighwayUploadOptions = {},
): Promise<void> {
    const state: HighwayPutTraceState = {
        startedAt: Date.now(),
        uploadedBytes: 0,
        connectCount: 0,
    };
    return runWithTraceRequest(async () => {
        log.trace(() => [
            'highway_put_start cmdId=%d uin=%j servers=%j totalBytes=%d fileMd5=%s extendBytes=%d',
            commandId,
            bridge.identity.uin,
            session.servers,
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
                options,
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
    bridge: BridgeContext,
    session: HighwaySession,
    commandId: number,
    source: ChunkSource,
    fileMd5: Uint8Array,
    extend: Uint8Array,
    trace: HighwayPutTraceState,
    options: HighwayUploadOptions,
): Promise<void> {
    const totalSize = source.size;
    const pathStr = `/cgi-bin/httpconn?htcmd=0x6FF0087&uin=${bridge.identity.uin}`;
    const abort = new AbortController();
    const { signal } = abort;
    const wakeups = new Set<() => void>();

    const wake = () => {
        for (const resolve of wakeups) {
            resolve();
        }

        wakeups.clear();
    };

    signal.addEventListener('abort', wake, { once: true });

    const fail = (reason: HighwayPutFailureReason, error: unknown): never => {
        if (!signal.aborted) {
            trace.failureReason = reason;
            trace.error = error;
            abort.abort(error);
        }

        throw signal.reason;
    };

    interface Worker {
        id: number;
        socket: net.Socket | null;
        serverIndex: number;
        connections: number;
    }
    const workers: Worker[] = [];
    const running = new Map<number, Promise<Worker>>();
    let succeeded = false;
    let sourceCloseFailure: { error: unknown } | undefined;
    let concurrency = 1;
    let effectiveConcurrency = 1;
    let activeRequests = 0;
    let sequence = 0;
    let retries = 0;
    let contiguous = 0;
    const confirmed = new Set<number>();

    const dropSocket = (worker: Worker) => {
        worker.socket?.destroy();
        worker.socket = null;
    };

    const acquire = async () => {
        while (activeRequests >= effectiveConcurrency) {
            signal.throwIfAborted();
            await new Promise<void>((resolve) => wakeups.add(resolve));
        }

        signal.throwIfAborted();
        activeRequests += 1;
    };

    const sendChunk = async (worker: Worker, piece: number): Promise<Worker> => {
        const offset = piece * HIGHWAY_BLOCK_SIZE;
        const chunkSize = Math.min(HIGHWAY_BLOCK_SIZE, totalSize - offset);
        let chunk: Uint8Array;

        try {
            chunk = await source.read(offset, chunkSize);

            if (chunk.byteLength !== chunkSize) {
                throw new Error(
                    `highway source returned ${chunk.byteLength} bytes, expected ${chunkSize} at offset ${offset}`,
                );
            }
        } catch (error) {
            return fail('source_read_failed', error);
        }

        signal.throwIfAborted();
        log.trace('highway_put_branch branch=chunk_read offset=%d bytes=%d', offset, chunkSize);
        const chunkMd5 = computeMd5(chunk);
        const rejectServer = (errorCode: number, segRetCode: number): never =>
            fail(
                'server_rejected',
                new Error(
                    `highway upload error_code=${errorCode} (cmdId=${commandId} chunk=${chunkSize}/${totalSize} offset=${offset} segRetCode=${segRetCode})`,
                ),
            );
        let transportAttempts = 0;
        let delayRetries = 0;

        for (;;) {
            await acquire();
            const retryTimes = transportAttempts + delayRetries;
            const attempt = retryTimes + 1;
            const requestSequence = concurrency === 1 ? 0 : ++sequence;
            const requestStarted = Date.now();

            try {
                const head = makeHighwayHead(
                    bridge.identity.uin,
                    commandId,
                    totalSize,
                    offset,
                    chunkSize,
                    chunkMd5,
                    fileMd5,
                    session.sigSession,
                    extend,
                    retryTimes,
                    requestSequence,
                );
                log.trace(() => [
                    'highway_put_branch branch=chunk_control_request offset=%d bytes=%d headBytes=%d headHex=%s',
                    offset,
                    chunkSize,
                    head.byteLength,
                    renderTraceBytes(head),
                ]);
                let body: Uint8Array;

                try {
                    if (
                        worker.socket &&
                        (worker.socket.destroyed ||
                            worker.socket.readableEnded ||
                            !worker.socket.writable)
                    ) {
                        dropSocket(worker);
                    }

                    if (!worker.socket) {
                        const connected = await connectHighway(
                            session.servers,
                            worker.serverIndex,
                            signal,
                        );
                        worker.socket = connected.socket;
                        worker.serverIndex = connected.serverIndex;
                        worker.connections += 1;
                        trace.connectCount += 1;
                        // Idle pooled connections can fail while another worker is active.
                        // Retain an error observer between requests; the next attempt reconnects.
                        const socket = worker.socket;
                        socket.on('error', (error) => {
                            log.trace(
                                'highway_put_branch branch=socket_error worker=%d error=%j',
                                worker.id,
                                highwayErrorText(error),
                            );
                            socket.destroy();
                        });
                        log.trace(
                            'highway_put_branch branch=%s offset=%d attempt=%d connection=%d worker=%d host=%j port=%d',
                            worker.connections === 1 ? 'connect' : 'reconnect',
                            offset,
                            attempt,
                            trace.connectCount,
                            worker.id,
                            connected.server.host,
                            connected.server.port,
                        );
                    }

                    log.trace(
                        'highway_put_branch branch=chunk_attempt offset=%d bytes=%d attempt=%d connection=%d worker=%d seq=%d',
                        offset,
                        chunkSize,
                        attempt,
                        trace.connectCount,
                        worker.id,
                        requestSequence,
                    );
                    body = await httpPostFrame(
                        worker.socket,
                        session.servers[worker.serverIndex]!.host,
                        pathStr,
                        packHighwayFrame(head, chunk),
                        signal,
                    );
                } catch (error) {
                    signal.throwIfAborted();

                    if (worker.connections === 0) {
                        return fail('connect_exhausted', error);
                    }

                    if (error instanceof HighwayResponseReadError && error.responseBody) {
                        log.trace(() => [
                            'highway_put_branch branch=chunk_control_response_partial offset=%d attempt=%d responseBytes=%d responseHex=%s',
                            offset,
                            attempt,
                            error.responseBody!.byteLength,
                            renderTraceBytes(error.responseBody!),
                        ]);
                    }

                    dropSocket(worker);
                    transportAttempts += 1;

                    if (transportAttempts >= HIGHWAY_MAX_CHUNK_ATTEMPTS) {
                        return fail(
                            'transport_exhausted',
                            new Error(
                                `highway upload transport failed after ${transportAttempts} attempts (cmdId=${commandId} chunk=${chunkSize}/${totalSize} offset=${offset} acknowledgedBytes=${trace.uploadedBytes}; current chunk unconfirmed): ${String(error)}`,
                                { cause: error },
                            ),
                        );
                    }

                    retries += 1;
                    worker.serverIndex = (worker.serverIndex + 1) % session.servers.length;
                    log.trace(
                        'highway_put_branch branch=chunk_retry offset=%d bytes=%d attempt=%d nextServer=%j error=%j',
                        offset,
                        chunkSize,
                        transportAttempts,
                        session.servers[worker.serverIndex],
                        highwayErrorText(error),
                    );
                    await sleepMs(HIGHWAY_RETRY_BASE_MS * transportAttempts, signal);
                    continue;
                }

                signal.throwIfAborted();
                log.trace(() => [
                    'highway_put_branch branch=chunk_control_response offset=%d bytes=%d responseBytes=%d responseHex=%s',
                    offset,
                    chunkSize,
                    body.byteLength,
                    renderTraceBytes(body),
                ]);
                let response: RespDataHighwayHead;

                try {
                    response = protobuf_decode<RespDataHighwayHead>(unpackHighwayFrame(body).head);
                } catch (error) {
                    return fail('control_decode_failed', error);
                }

                const errorCode = response.errorCode ?? 0;
                const segRetCode = response.msgSegHead?.retCode ?? 0;
                log.trace(
                    'highway_put_branch branch=chunk_control_decoded offset=%d errorCode=%d segRetCode=%d',
                    offset,
                    errorCode,
                    segRetCode,
                );

                if (HIGHWAY_DELAY_RETRY_CODES.has(errorCode)) {
                    dropSocket(worker);
                    delayRetries += 1;

                    if (delayRetries >= HIGHWAY_MAX_DELAY_RETRIES) {
                        rejectServer(errorCode, segRetCode);
                    }

                    retries += 1;

                    if (effectiveConcurrency > 1) {
                        log.warn(
                            'highway upload reducing concurrency from %d to 1 after server backpressure (cmdId=%d offset=%d code=%d)',
                            effectiveConcurrency,
                            commandId,
                            offset,
                            errorCode,
                        );
                        effectiveConcurrency = 1;
                    }

                    worker.serverIndex = (worker.serverIndex + 1) % session.servers.length;
                    const delayMs = HIGHWAY_DELAY_RETRY_MS;
                    log.trace(
                        'highway_put_branch branch=chunk_delay_retry offset=%d bytes=%d attempt=%d errorCode=%d delayMs=%d',
                        offset,
                        chunkSize,
                        delayRetries,
                        errorCode,
                        delayMs,
                    );
                    await sleepMs(delayMs, signal);
                    continue;
                }

                if (errorCode !== 0 || segRetCode !== 0) {
                    rejectServer(errorCode, segRetCode);
                }

                const seg = response.msgSegHead;
                // Each socket has exactly one outstanding request. Older responses
                // may omit echo fields (Proton decodes missing optionals as null);
                // when supplied, they must match that request.
                const mismatch =
                    (response.msgBaseHead?.seq != null &&
                        response.msgBaseHead.seq !== requestSequence) ||
                    (seg?.filesize != null && seg.filesize !== BigInt(totalSize)) ||
                    (seg?.dataOffset != null && seg.dataOffset !== BigInt(offset)) ||
                    (seg?.dataLength != null && seg.dataLength !== chunkSize);

                if (mismatch) {
                    return fail(
                        'ack_mismatch',
                        new Error(
                            `highway acknowledgement mismatch (cmdId=${commandId} offset=${offset} bytes=${chunkSize} seq=${requestSequence}; ackOffset=${String(seg?.dataOffset)} ackBytes=${String(seg?.dataLength)} ackSeq=${String(response.msgBaseHead?.seq)})`,
                        ),
                    );
                }

                break;
            } finally {
                activeRequests -= 1;
                wake();
                log.trace(
                    'highway_put_branch branch=chunk_attempt_finished offset=%d worker=%d attempt=%d elapsedMs=%d',
                    offset,
                    worker.id,
                    attempt,
                    Date.now() - requestStarted,
                );
            }
        }

        trace.uploadedBytes += chunkSize;
        confirmed.add(piece);

        while (confirmed.delete(contiguous)) {
            contiguous += 1;
        }

        log.trace(
            'highway_put_branch branch=chunk_completed offset=%d totalBytes=%d acknowledgedBytes=%d contiguousBytes=%d worker=%d',
            offset + chunkSize,
            totalSize,
            trace.uploadedBytes,
            Math.min(totalSize, contiguous * HIGHWAY_BLOCK_SIZE),
            worker.id,
        );
        return worker;
    };

    try {
        try {
            concurrency = validateUploadConcurrency(
                options.concurrency === undefined ? 1 : options.concurrency,
            );
        } catch (error) {
            fail('invalid_options', error);
        }

        const pieces = Math.ceil(totalSize / HIGHWAY_BLOCK_SIZE);
        // The final piece commits the file only after every preceding piece is
        // acknowledged. One/two-piece files therefore need just one connection.
        effectiveConcurrency = Math.max(1, Math.min(concurrency, pieces - 1));
        const slots = effectiveConcurrency;

        for (let id = 0; id < slots; id++) {
            workers.push({ id, socket: null, serverIndex: 0, connections: 0 });
        }

        const free = [...workers];
        let next = 0;
        log.debug(
            'highway upload start: bytes=%d concurrency=%d effectiveConcurrency=%d cmdId=%d',
            totalSize,
            concurrency,
            slots,
            commandId,
        );

        while (next < pieces || running.size > 0) {
            signal.throwIfAborted();

            // Bound the distance from the first unconfirmed piece as well as
            // the number in flight. A slow early piece must not create an
            // unbounded hole even if later requests finish immediately.
            while (
                free.length &&
                running.size < effectiveConcurrency &&
                next < pieces &&
                next < contiguous + 10 &&
                (next !== pieces - 1 || contiguous === next)
            ) {
                const worker = free.pop()!;
                const piece = next++;
                const job = sendChunk(worker, piece).catch((error: unknown) => {
                    if (!signal.aborted) {
                        abort.abort(error);
                    }

                    throw error;
                });
                running.set(piece, job);
            }

            if (running.size === 0) {
                throw new Error('highway upload stalled before all chunks were acknowledged');
            }

            const finished = await Promise.race(
                [...running].map(async ([piece, job]) => ({ piece, worker: await job })),
            );
            running.delete(finished.piece);
            free.push(finished.worker);
        }

        if (trace.uploadedBytes !== totalSize || contiguous !== pieces) {
            throw new Error('highway upload completed without confirming the whole file');
        }

        succeeded = true;
        log.debug(
            'highway upload done: %d bytes over %d connection(s) (cmdId=%d concurrency=%d effectiveConcurrency=%d retries=%d elapsedMs=%d)',
            totalSize,
            trace.connectCount,
            commandId,
            concurrency,
            effectiveConcurrency,
            retries,
            Date.now() - trace.startedAt,
        );
    } finally {
        abort.abort(new Error('highway upload stopped'));

        for (const worker of workers) {
            dropSocket(worker);
        }

        // Wait for positional reads, writes and retry waits before closing the
        // shared file handle. Never leave a worker sending after this call fails.
        await Promise.allSettled(running.values());

        for (const worker of workers) {
            dropSocket(worker);
        }

        signal.removeEventListener('abort', wake);

        try {
            await source.close();
        } catch (error) {
            if (succeeded) {
                sourceCloseFailure = { error };
            } else {
                log.warn(
                    'highway source close failed after upload failure: %s',
                    highwayErrorText(error),
                );
            }
        }
    }

    if (sourceCloseFailure) {
        trace.failureReason = 'source_close_failed';
        trace.error = sourceCloseFailure.error;
        throw sourceCloseFailure.error;
    }
}
