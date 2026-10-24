import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { getLogLevel, setLogLevel, subscribeLogs, type LogEntry } from '@snowluma/common/logger';
import type { ReqDataHighwayHead, RespDataHighwayHead } from '@snowluma/proto-defs/highway';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '@snowluma/protocol/bridge-context';
import { packHighwayFrame, unpackHighwayFrame, computeMd5 } from '@snowluma/protocol/highway/utils';
import {
    uploadHighwayHttp,
    type ChunkSource,
    type HighwaySession,
} from '@snowluma/protocol/highway';

const { connect } = vi.hoisted(() => ({ connect: vi.fn() }));
vi.mock('net', () => ({ default: { createConnection: connect } }));
const BLOCK = 1024 * 1024;
const bridge = { identity: { uin: '10001' } } as unknown as BridgeContext;
const session: HighwaySession = {
    sigSession: new Uint8Array([1]),
    sessionKey: new Uint8Array(),
    servers: [
        { host: '192.0.2.1', port: 80 },
        { host: '192.0.2.2', port: 80 },
    ],
};
const turn = () => new Promise<void>((resolve) => setImmediate(resolve));

interface Request {
    socket: TestSocket;
    head: ReqDataHighwayHead;
    bytes: Uint8Array;
    offset: number;
    respond(override?: RespDataHighwayHead): void;
    frame(bytes: Uint8Array): void;
    disconnect(): void;
}
let requests: Request[];
let sockets: TestSocket[];
let active: Set<Request>;
let peak: number;
let onRequest: (request: Request) => void;

class TestSocket extends EventEmitter {
    destroyed = false;
    readableEnded = false;
    writable = true;
    private buffer = Buffer.alloc(0);
    setTimeout() {
        return this;
    }
    write(data: Uint8Array, callback: (error?: Error) => void): boolean {
        if (this.destroyed) {
            callback(new Error('socket closed'));
            return false;
        }

        this.buffer = Buffer.concat([this.buffer, data]);
        const end = this.buffer.indexOf('\r\n\r\n');

        if (end >= 0) {
            const length = Number(
                this.buffer
                    .subarray(0, end)
                    .toString()
                    .match(/Content-Length: (\d+)/i)![1],
            );

            if (this.buffer.length >= end + 4 + length) {
                const { head, body } = unpackHighwayFrame(
                    this.buffer.subarray(end + 4, end + 4 + length),
                );
                const decoded = protobuf_decode<ReqDataHighwayHead>(head);
                this.buffer = this.buffer.subarray(end + 4 + length);
                const request: Request = {
                    socket: this,
                    head: decoded,
                    bytes: body,
                    offset: Number(decoded.msgSegHead?.dataOffset ?? 0n),
                    frame: (frame) => {
                        if (this.destroyed) {
                            throw new Error('reply on destroyed socket');
                        }

                        active.delete(request);
                        this.emit(
                            'data',
                            Buffer.concat([
                                Buffer.from(
                                    `HTTP/1.1 200 OK\r\nContent-Length: ${frame.length}\r\n\r\n`,
                                ),
                                frame,
                            ]),
                        );
                    },
                    respond: (override = {}) =>
                        request.frame(
                            packHighwayFrame(
                                protobuf_encode<RespDataHighwayHead>({
                                    msgBaseHead: { seq: decoded.msgBaseHead?.seq },
                                    msgSegHead: {
                                        filesize: decoded.msgSegHead?.filesize,
                                        dataOffset: decoded.msgSegHead?.dataOffset,
                                        dataLength: decoded.msgSegHead?.dataLength,
                                    },
                                    ...override,
                                }),
                                new Uint8Array(),
                            ),
                        ),
                    disconnect: () => this.emit('error', new Error('ECONNRESET')),
                };
                expect([...active].some((item) => item.socket === this)).toBe(false);
                requests.push(request);
                active.add(request);
                peak = Math.max(peak, active.size);
                // Deliberately respond before the write callback. Real fast peers
                // can reply while socket.write is still completing.
                onRequest(request);
            }
        }

        callback();
        return true;
    }
    destroy() {
        if (!this.destroyed) {
            this.destroyed = true;
            this.writable = false;

            for (const request of active) {
                if (request.socket === this) {
                    active.delete(request);
                }
            }

            queueMicrotask(() => this.emit('close'));
        }

        return this;
    }
}

class Source implements ChunkSource {
    reads: number[] = [];
    closes = 0;
    constructor(readonly size: number) {}
    async read(offset: number, length: number) {
        this.reads.push(offset);
        return new Uint8Array(length).fill(offset / BLOCK + 1);
    }
    async close() {
        this.closes += 1;
    }
}

function upload(source: ChunkSource, concurrency: number) {
    return uploadHighwayHttp(bridge, session, 1005, source, new Uint8Array(16), new Uint8Array(), {
        concurrency,
    });
}

const level = getLogLevel();
beforeEach(() => {
    requests = [];
    sockets = [];
    active = new Set();
    peak = 0;

    onRequest = () => {};

    connect.mockReset().mockImplementation((_options, listener) => {
        const socket = new TestSocket();
        sockets.push(socket);
        setImmediate(listener);
        return socket;
    });
});
afterEach(() => {
    setLogLevel(level);

    for (const socket of sockets) {
        socket.destroy();
    }
});

describe('bounded parallel highway uploads', () => {
    it.each([2, 3, 4])(
        'uses %i connections, accepts out-of-order acknowledgements and sends the tail last',
        async (concurrency) => {
            const source = new Source(6 * BLOCK + 17);
            const confirmed = new Set<number>();

            const checkAndAck = (request: Request) => {
                if (request.offset === 6 * BLOCK) {
                    expect(confirmed.size).toBe(6);
                }

                expect(request.bytes.every((byte) => byte === request.offset / BLOCK + 1)).toBe(
                    true,
                );
                expect(Buffer.from(request.head.msgSegHead!.md5!)).toEqual(
                    Buffer.from(computeMd5(request.bytes)),
                );
                confirmed.add(request.offset);
                request.respond();
            };

            const result = upload(source, concurrency);
            await vi.waitFor(() => expect(requests).toHaveLength(concurrency));
            expect(source.closes).toBe(0);
            onRequest = checkAndAck;

            for (const request of [...active].reverse()) {
                checkAndAck(request);
            }

            await result;
            expect(peak).toBe(concurrency);
            expect(sockets).toHaveLength(concurrency);
            expect(requests).toHaveLength(7);
            expect(new Set(requests.map((request) => request.head.msgBaseHead?.seq)).size).toBe(7);
            expect(source.closes).toBe(1);
            expect(sockets.every((socket) => socket.destroyed)).toBe(true);
        },
    );

    it('logs confirmed bytes separately from the contiguous prefix after out-of-order replies', async () => {
        const entries: LogEntry[] = [];
        setLogLevel('trace');
        const unsubscribe = subscribeLogs((entry) => entries.push(entry));
        const source = new Source(3 * BLOCK + 1);

        try {
            const result = upload(source, 3);
            await vi.waitFor(() => expect(requests).toHaveLength(3));
            requests[2].respond();
            await vi.waitFor(() =>
                expect(
                    entries.some((entry) =>
                        entry.message.includes('acknowledgedBytes=1048576 contiguousBytes=0'),
                    ),
                ).toBe(true),
            );
            expect(requests).toHaveLength(3);
            onRequest = (request) => request.respond();
            requests[1].respond();
            requests[0].respond();
            await result;
            const terminal = entries.filter((entry) =>
                entry.message.startsWith('highway_put_terminal '),
            );
            expect(terminal).toHaveLength(1);
            expect(terminal[0]?.message).toContain(`uploadedBytes=${source.size}`);
        } finally {
            unsubscribe();
        }
    });

    it('surfaces repeated backpressure after the retry budget is exhausted', async () => {
        const source = new Source(4 * BLOCK);

        onRequest = (request) => {
            if (request.offset === 0) {
                request.respond({ errorCode: 102902 });
            } else {
                request.respond();
            }
        };

        await expect(upload(source, 3)).rejects.toThrow(/error_code=102902/);
        expect(requests.filter((request) => request.offset === 0)).toHaveLength(8);
        expect(requests.some((request) => request.offset === 3 * BLOCK)).toBe(false);
        expect(source.closes).toBe(1);
    });

    it('limits lookahead behind a slow chunk and recovers an idle connection failure', async () => {
        const source = new Source(14 * BLOCK + 1);

        onRequest = (request) => {
            if (request.offset !== 0) {
                request.respond();
            }
        };

        const result = upload(source, 4);
        await vi.waitFor(() => expect(requests).toHaveLength(10));
        await turn();
        expect(Math.max(...requests.map((request) => request.offset))).toBe(9 * BLOCK);
        const idle = sockets.find(
            (socket) => ![...active].some((request) => request.socket === socket),
        )!;
        idle.emit('error', new Error('idle connection reset'));
        onRequest = (request) => request.respond();
        requests[0].respond();
        await result;
        expect(requests).toHaveLength(15);
        expect(source.closes).toBe(1);
    });

    it('retries only the unconfirmed range after a transport failure', async () => {
        const source = new Source(6 * BLOCK);
        let failed = false;

        onRequest = (request) => {
            if (request.offset === BLOCK && !failed) {
                failed = true;
                request.disconnect();
            } else {
                request.respond();
            }
        };

        await upload(source, 3);
        const retried = requests.filter((request) => request.offset === BLOCK);
        expect(retried).toHaveLength(2);
        expect(retried[1].bytes).toEqual(retried[0].bytes);
        expect(retried[1].head.msgBaseHead?.retryTimes).toBe(1);
        expect(retried[1].head.msgBaseHead?.seq).not.toBe(retried[0].head.msgBaseHead?.seq);
        expect(source.reads).toHaveLength(6);
        expect(requests.filter((request) => request.offset !== BLOCK)).toHaveLength(5);
        expect(source.closes).toBe(1);
    });

    it.each([102902, 302902])(
        'drains in-flight requests and reduces concurrency on %i',
        async (code) => {
            const source = new Source(7 * BLOCK);
            const entries: LogEntry[] = [];
            const unsubscribe = subscribeLogs((entry) => entries.push(entry));

            try {
                const result = upload(source, 4);
                await vi.waitFor(() => expect(requests).toHaveLength(4));
                requests[0].respond({ errorCode: code });
                await vi.waitFor(() =>
                    expect(
                        entries.some((entry) =>
                            entry.message.includes('reducing concurrency from 4 to 1'),
                        ),
                    ).toBe(true),
                );
                await turn();
                expect(requests).toHaveLength(4);
                let afterDrainPeak = 0;

                onRequest = (request) => {
                    afterDrainPeak = Math.max(afterDrainPeak, active.size);
                    request.respond();
                };

                for (const request of [...active]) {
                    request.respond();
                }

                await result;
                expect(afterDrainPeak).toBe(1);
                expect(requests.filter((request) => request.offset === 0)).toHaveLength(2);
                expect(requests).toHaveLength(8);
                expect(source.closes).toBe(1);
            } finally {
                unsubscribe();
            }
        },
    );

    it.each([
        { msgBaseHead: { seq: 999 } },
        { msgSegHead: { dataOffset: 99n } },
        { msgSegHead: { dataLength: 99 } },
        { msgSegHead: { filesize: 99n } },
    ])('rejects mismatched acknowledgements without retrying (case %#)', async (response) => {
        const source = new Source(4 * BLOCK);
        onRequest = (request) => request.respond(response);
        await expect(upload(source, 3)).rejects.toThrow(/acknowledgement mismatch/);
        expect(requests.every((request) => (request.head.msgBaseHead?.retryTimes ?? 0) === 0)).toBe(
            true,
        );
        expect(requests.some((request) => request.offset === 3 * BLOCK)).toBe(false);
        expect(source.closes).toBe(1);
        expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    });

    it('rejects segment-level errors even when the top-level code is zero', async () => {
        const source = new Source(4 * BLOCK);
        onRequest = (request) => request.respond({ msgSegHead: { retCode: 921 } });
        await expect(upload(source, 3)).rejects.toThrow(/segRetCode=921/);
        expect(source.closes).toBe(1);
    });

    it('stops peers on rejection and waits for pending source reads before closing', async () => {
        let release!: () => void;
        let reading = false;
        const source = new Source(5 * BLOCK);
        const read = source.read.bind(source);

        source.read = async (offset, length) => {
            if (offset === BLOCK) {
                reading = true;
                await new Promise<void>((resolve) => {
                    release = resolve;
                });
                reading = false;
            }

            return read(offset, length);
        };

        const close = vi.spyOn(source, 'close').mockImplementation(async () => {
            expect(reading).toBe(false);
        });
        const result = upload(source, 3);
        const rejected = expect(result).rejects.toThrow(/error_code=921/);
        await vi.waitFor(() => expect(requests).toHaveLength(2));
        requests.find((request) => request.offset === 0)!.respond({ errorCode: 921 });
        await turn();
        expect(close).not.toHaveBeenCalled();
        release();
        await rejected;
        expect(close).toHaveBeenCalledTimes(1);
        expect(requests).toHaveLength(2);
        expect(sockets.every((socket) => socket.destroyed)).toBe(true);
    });

    it('stops after bounded transport retries without sending the final chunk', async () => {
        const source = new Source(5 * BLOCK);

        onRequest = (request) => {
            if (request.offset === 0) {
                request.disconnect();
            } else {
                request.respond();
            }
        };

        await expect(upload(source, 3)).rejects.toThrow(/transport failed after 3 attempts/);
        expect(requests.filter((request) => request.offset === 0)).toHaveLength(3);
        expect(requests.some((request) => request.offset === 4 * BLOCK)).toBe(false);
        expect(source.closes).toBe(1);
    });

    it.each([1, BLOCK + 1, 2 * BLOCK])('keeps a %i-byte upload on one connection', async (size) => {
        onRequest = (request) => request.respond();
        await upload(new Source(size), 4);
        expect(peak).toBe(1);
        expect(sockets).toHaveLength(1);
    });

    it('keeps legacy success responses without echo fields compatible', async () => {
        onRequest = (request) => request.respond({ msgBaseHead: undefined, msgSegHead: undefined });
        await upload(new Source(4 * BLOCK), 3);
        expect(requests).toHaveLength(4);
    });

    it.each([0, 5, -1, 1.5, NaN])(
        'rejects invalid concurrency %s and closes the source',
        async (concurrency) => {
            const source = new Source(4 * BLOCK);
            await expect(upload(source, concurrency)).rejects.toThrow(/integer from 1 to 4/);
            expect(source.closes).toBe(1);
            expect(requests).toHaveLength(0);
        },
    );

    it('rejects short reads instead of acknowledging bytes that were not uploaded', async () => {
        const source = new Source(4 * BLOCK);
        source.read = async () => new Uint8Array(1);
        await expect(upload(source, 3)).rejects.toThrow(/expected 1048576/);
        expect(requests).toHaveLength(0);
        expect(source.closes).toBe(1);
    });
});
