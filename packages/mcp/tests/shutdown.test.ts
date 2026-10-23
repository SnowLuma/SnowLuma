import { PassThrough } from 'node:stream';
import { Server } from '@modelcontextprotocol/server';
import { serveStdio, StdioServerTransport } from '@modelcontextprotocol/server/stdio';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { shutdownRuntime } from '../src/shutdown';

afterEach(() => vi.restoreAllMocks());

describe('runtime shutdown', () => {
    it('finishes durable cleanup before closing the protocol normally', async () => {
        const durable = Promise.withResolvers<void>();
        const closeProtocol = vi.fn(async () => undefined);
        const forceClose = vi.fn(async () => undefined);
        const onTimeout = vi.fn();
        const closing = shutdownRuntime({
            closeFeatures: () => durable.promise,
            closeProtocol,
            forceClose,
            onTimeout,
        });
        await Promise.resolve();
        expect(closeProtocol).not.toHaveBeenCalled();
        durable.resolve();
        await closing;
        expect(closeProtocol).toHaveBeenCalledOnce();
        expect(forceClose).not.toHaveBeenCalled();
        expect(onTimeout).not.toHaveBeenCalled();
    });

    it('releases features and forcibly closes real stdio when a subscriber stops reading', async () => {
        const input = new PassThrough();
        const output = new PassThrough({ highWaterMark: 1 });
        const transport = new StdioServerTransport(input, output);
        const handle = serveStdio(
            () =>
                new Server(
                    { name: 'shutdown-test', version: '1' },
                    { capabilities: { resources: { subscribe: true, listChanged: true } } },
                ),
            { transport },
        );
        const order: string[] = [];
        const onTimeout = vi.fn(() => order.push('timeout'));
        const forceClose = vi.fn(async () => {
            order.push('force');
            await transport.close();
            output.destroy();
        });

        try {
            input.write(
                `${JSON.stringify({
                    jsonrpc: '2.0',
                    id: 1,
                    method: 'subscriptions/listen',
                    params: {
                        notifications: { resourcesUpdated: ['test://events'] },
                        _meta: {
                            'io.modelcontextprotocol/protocolVersion': '2026-07-28',
                            'io.modelcontextprotocol/clientCapabilities': {},
                        },
                    },
                })}\n`,
            );
            await vi.waitFor(() => expect(output.writableLength).toBeGreaterThan(0));
            await shutdownRuntime({
                closeFeatures: async () => {
                    order.push('features');
                },
                closeProtocol: () => {
                    order.push('protocol');
                    return handle.close();
                },
                forceClose,
                graceMs: 10,
                onTimeout,
            });
            expect(order).toEqual(['features', 'protocol', 'timeout', 'force']);
            expect(forceClose).toHaveBeenCalledOnce();
            expect(output.destroyed).toBe(true);
            expect(input.listenerCount('data')).toBe(0);
        } finally {
            await transport.close();
            input.destroy();
            output.destroy();
        }
    });

    it('still closes the protocol after a feature failure and preserves that error', async () => {
        const failure = new Error('feature shutdown failed');
        const closeProtocol = vi.fn(async () => undefined);
        const forceClose = vi.fn(async () => undefined);
        await expect(
            shutdownRuntime({
                closeFeatures: async () => {
                    throw failure;
                },
                closeProtocol,
                forceClose,
            }),
        ).rejects.toBe(failure);
        expect(closeProtocol).toHaveBeenCalledOnce();
        expect(forceClose).not.toHaveBeenCalled();
    });

    it('preserves all cleanup errors and forces closure after a protocol failure', async () => {
        const failures = [new Error('features'), new Error('protocol'), new Error('force')];
        await expect(
            shutdownRuntime({
                closeFeatures: async () => {
                    throw failures[0];
                },
                closeProtocol: async () => {
                    throw failures[1];
                },
                forceClose: async () => {
                    throw failures[2];
                },
            }),
        ).rejects.toMatchObject({ errors: failures });
    });

    it('does not skip forced closure when timeout reporting fails', async () => {
        const reportingError = new Error('reporting');
        const forceClose = vi.fn(async () => undefined);
        await expect(
            shutdownRuntime({
                closeFeatures: async () => undefined,
                closeProtocol: () => new Promise<void>(() => undefined),
                forceClose,
                graceMs: 1,
                onTimeout: () => {
                    throw reportingError;
                },
            }),
        ).rejects.toBe(reportingError);
        expect(forceClose).toHaveBeenCalledOnce();
    });

    it('reports a protocol rejection that arrives after the shutdown deadline', async () => {
        const protocol = Promise.withResolvers<void>();
        const onLateProtocolError = vi.fn();
        await shutdownRuntime({
            closeFeatures: async () => undefined,
            closeProtocol: () => protocol.promise,
            forceClose: async () => undefined,
            graceMs: 1,
            onTimeout: vi.fn(),
            onLateProtocolError,
        });
        const failure = new Error('late protocol failure');
        protocol.reject(failure);
        await vi.waitFor(() => expect(onLateProtocolError).toHaveBeenCalledWith(failure));
    });
});
