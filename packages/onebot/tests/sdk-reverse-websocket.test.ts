import { createHash } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { Readable } from 'node:stream';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
    createReverseWebSocketServer,
    type SnowLumaReverseWebSocketServer,
} from '../../sdk/src/node/index';
import { WsClientAdapter } from '../src/network/ws-client-adapter';
import { buildDispatchPayload } from '../src/event-filter';
import { okResponse, type JsonObject, type WsRole } from '../src/types';
import type { ApiActionContext } from '../src/api-handler';
import { actions as uploadActions, __test as uploadTest } from '../src/actions/stream-file';
import { actions as downloadActions } from '../src/actions/stream-download';
import { createCompiledTestHandler, testAction } from './helpers/compiled-action-handler';

describe('SDK reverse server against the real OneBot reverse adapter', () => {
    const adapters: WsClientAdapter[] = [];
    let server: SnowLumaReverseWebSocketServer | undefined;

    afterEach(async () => {
        await Promise.all(adapters.splice(0).map((adapter) => adapter.close()));
        await server?.close();

        for (const key of uploadTest.uploads.keys()) {
            uploadTest.cleanupUpload(key, true);
        }
    });

    it.each(['universal', 'split'] as const)(
        '%s carries events, actions and complete binary streams',
        async (mode) => {
            server = createReverseWebSocketServer({
                port: 0,
                accessToken: 'integration-test',
                selfIds: ['10001'],
            });
            const errors = vi.fn();
            server.on('error', errors);
            await server.listen();
            const { port } = server.address as AddressInfo;
            const api = createCompiledTestHandler({} as ApiActionContext, [
                ...uploadActions,
                ...downloadActions,
                testAction('sdk_ping', () => okResponse({ pong: true })),
            ]);
            const roles: WsRole[] = mode === 'universal' ? ['Universal'] : ['Api', 'Event'];

            for (const role of roles) {
                const adapter = new WsClientAdapter(
                    `reverse-${role}`,
                    {
                        name: `reverse-${role}`,
                        url: `ws://127.0.0.1:${port}/onebot/v11/ws`,
                        accessToken: 'integration-test',
                        role,
                        messageFormat: 'array',
                        reportSelfMessage: false,
                    },
                    {
                        uin: '10001',
                        api,
                        buildLifecycleEvent: (subType) => ({
                            self_id: 10001,
                            post_type: 'meta_event',
                            meta_event_type: 'lifecycle',
                            sub_type: subType,
                        }),
                        buildHeartbeatEvent: () => ({
                            self_id: 10001,
                            post_type: 'meta_event',
                            meta_event_type: 'heartbeat',
                        }),
                    },
                );
                adapters.push(adapter);
                adapter.open();
            }

            await vi.waitFor(() => {
                expect(server!.getClient('10001')?.canCallActions).toBe(true);
                expect(server!.getClient('10001')?.canReceiveEvents).toBe(true);
                expect(adapters.every((adapter) => adapter.describeStatus().status === 'ok')).toBe(
                    true,
                );
            });
            const client = server.getClient('10001')!;
            expect(await client.raw('sdk_ping')).toEqual({ pong: true });
            const seen = vi.fn();
            client.on('event', seen);
            const received = client.waitForMessage((event) => event.message_id === -42, {
                timeoutMs: 1000,
            });
            const event: JsonObject = {
                self_id: 10001,
                time: 1,
                post_type: 'message',
                message_type: 'private',
                sub_type: 'friend',
                user_id: 20001,
                message_id: -42,
                message: [{ type: 'text', data: { text: 'wire test' } }],
                raw_message: 'wire test',
            };

            for (const adapter of adapters) {
                const own = { ...event, post_type: 'message_sent' };
                adapter.onEvent(own, buildDispatchPayload(own));
                adapter.onEvent(event, buildDispatchPayload(event));
            }

            expect((await received).message_id).toBe(-42);
            expect(seen.mock.calls.some(([event]) => event.post_type === 'message_sent')).toBe(
                false,
            );
            const bytes = Buffer.from('reverse transport binary stream\n'.repeat(3000));
            const sha256 = createHash('sha256').update(bytes).digest('hex');
            const uploaded = await client.uploadFileStream(Readable.from([bytes]), {
                fileSize: bytes.length,
                chunkSize: 8192,
                filename: 'reverse.bin',
                expectedSha256: sha256,
                fileRetention: 0,
            });
            const chunks: Uint8Array[] = [];
            const stream = client.downloadFileStream({
                file: uploaded.file_path,
                chunk_size: 4096,
            });

            while (true) {
                const next = await stream.next();

                if (next.done) {
                    expect(next.value.total_bytes).toBe(bytes.length);
                    break;
                }

                chunks.push(next.value);
            }

            expect(Buffer.concat(chunks)).toEqual(bytes);
            expect(errors).not.toHaveBeenCalled();
        },
    );
});
