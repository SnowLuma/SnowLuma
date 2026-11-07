import net from 'node:net';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeContext } from '../../src/bridge-context';
import {
    BufferChunkSource,
    uploadHighwayHttp,
    type HighwayServer,
} from '../../src/highway/highway-client';
import { packHighwayFrame } from '../../src/highway/utils';

const servers: net.Server[] = [];
const sockets = new Set<net.Socket>();

afterEach(async () => {
    vi.unstubAllEnvs();

    for (const socket of sockets) {
        socket.destroy();
    }

    await Promise.all(
        servers.splice(0).map(
            (server) =>
                new Promise<void>((resolve, reject) => {
                    server.close((error) => (error ? reject(error) : resolve()));
                }),
        ),
    );
});

async function listen(
    reply: boolean,
): Promise<{ address: HighwayServer; connections: () => number }> {
    let connections = 0;
    const server = net.createServer((socket) => {
        connections++;
        sockets.add(socket);
        socket.once('close', () => sockets.delete(socket));
        let received = Buffer.alloc(0);
        socket.on('data', (bytes: Buffer) => {
            received = Buffer.concat([received, bytes]);
            const end = received.indexOf('\r\n\r\n');

            if (!reply || end < 0) {
                return;
            }

            const header = received.subarray(0, end).toString('ascii');
            const length = Number(header.match(/Content-Length: (\d+)/i)?.[1]);

            if (received.length < end + 4 + length) {
                return;
            }

            const frame = packHighwayFrame(new Uint8Array(), new Uint8Array());
            socket.write(
                Buffer.concat([
                    Buffer.from(`HTTP/1.1 200 OK\r\nContent-Length: ${frame.byteLength}\r\n\r\n`),
                    frame,
                ]),
            );
            received = received.subarray(end + 4 + length);
        });
    });
    await new Promise<void>((resolve, reject) => {
        server.once('error', reject);
        server.listen(0, '127.0.0.1', () => {
            server.off('error', reject);
            resolve();
        });
    });
    servers.push(server);
    const address = server.address();

    if (!address || typeof address === 'string') {
        throw new Error('missing loopback address');
    }

    return {
        address: { host: address.address, port: address.port },
        connections: () => connections,
    };
}

function bridge(uin: string): BridgeContext {
    return { identity: { uin } } as unknown as BridgeContext;
}

function send(
    owner: BridgeContext,
    candidates: HighwayServer[],
    source = new BufferChunkSource(new Uint8Array([1, 2, 3])),
) {
    return uploadHighwayHttp(
        owner,
        { sigSession: new Uint8Array([1]), sessionKey: new Uint8Array(), servers: candidates },
        1004,
        source,
        new Uint8Array(16),
        new Uint8Array(),
    );
}

describe('highway upload over real loopback sockets', () => {
    it('switches idle ports and remembers only confirmed success for that account', async () => {
        vi.stubEnv('SNOWLUMA_HIGHWAY_UPLOAD_IDLE_TIMEOUT_MS', '100');
        vi.stubEnv('SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS', '5000');
        const idle = await listen(false);
        const healthy = await listen(true);
        const owner = bridge('10001');
        const candidates = [idle.address, healthy.address];
        await send(owner, candidates);
        await send(owner, candidates);
        expect(idle.connections()).toBe(1);
        expect(healthy.connections()).toBe(2);
        await send(bridge('10002'), candidates);
        expect(idle.connections()).toBe(2);
        expect(healthy.connections()).toBe(3);
    });

    it('rejects an unresponsive peer at the total deadline and closes its source once', async () => {
        vi.stubEnv('SNOWLUMA_HIGHWAY_UPLOAD_IDLE_TIMEOUT_MS', '10000');
        vi.stubEnv('SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS', '100');
        const idle = await listen(false);
        const source = new BufferChunkSource(new Uint8Array([1, 2, 3]));
        const close = vi.spyOn(source, 'close');
        await expect(send(bridge('10003'), [idle.address], source)).rejects.toThrow(
            'timed out after 100ms',
        );
        expect(close).toHaveBeenCalledTimes(1);
        expect(idle.connections()).toBe(1);
    });
});
