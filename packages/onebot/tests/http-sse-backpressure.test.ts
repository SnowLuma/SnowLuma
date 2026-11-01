import { describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'node:events';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { createLogger } from '@snowluma/common/logger';
import { HttpSseConnections } from '../src/network/http-sse-connections';
import { buildDispatchPayload } from '../src/event-filter';

class Response extends EventEmitter {
    writableLength = 0;
    destroyed = false;
    blocked = false;
    throwOnWrite = false;
    readonly frames: string[] = [];
    writeHead = vi.fn();
    flushHeaders = vi.fn();
    write(text: string): boolean {
        if (this.throwOnWrite) {
            throw new Error('test write failure');
        }

        this.frames.push(text);
        return !this.blocked;
    }
    destroy(): void {
        this.destroyed = true;
        this.emit('close');
    }
    end = vi.fn();
}

describe('SSE bounded buffers', () => {
    it('pauses until drain, disconnects only the overflowing peer, and bounds replay by bytes', () => {
        const owner = new HttpSseConnections(
            { name: 'bounded', port: 0 },
            createLogger('SseTest'),
            () => ['{}'],
        );
        const request = {
            headers: {},
            socket: { setTimeout: vi.fn() },
        } as unknown as IncomingMessage;
        const slow = new Response();
        const fast = new Response();
        owner.accept(request, slow as unknown as ServerResponse);
        owner.accept(request, fast as unknown as ServerResponse);
        const cursor = /^id: (.+)$/m.exec(fast.frames[1])![1];
        slow.blocked = true;
        owner.onEvent(buildDispatchPayload({ index: 1 }));
        owner.onEvent(buildDispatchPayload({ index: 2 }));
        expect(slow.frames).toHaveLength(3);
        slow.blocked = false;
        slow.emit('drain');
        expect(slow.frames).toHaveLength(4);
        slow.blocked = true;
        owner.onEvent(buildDispatchPayload({ index: 3 }));

        for (let index = 4; index < 8; index += 1) {
            owner.onEvent(buildDispatchPayload({ index, text: 'x'.repeat(3 * 1024 * 1024) }));
        }

        expect(slow.destroyed).toBe(true);
        expect(fast.destroyed).toBe(false);
        expect(fast.frames.at(-1)).toContain('"index":7');
        expect(owner.connectionCount).toBe(1);
        const expired = new Response();
        owner.accept(
            { ...request, headers: { 'last-event-id': cursor } } as IncomingMessage,
            expired as unknown as ServerResponse,
        );
        expect(expired.writeHead).toHaveBeenCalledWith(409, expect.anything());
        owner.close('test finished');
        expect(fast.destroyed).toBe(true);
        expect(owner.connectionCount).toBe(0);
    });

    it('reports a synchronous write failure and continues serving other clients', () => {
        const log = createLogger('SseTest');
        const warning = vi.spyOn(log, 'warn');
        const owner = new HttpSseConnections({ name: 'errors', port: 0 }, log, () => ['{}']);
        const request = {
            headers: {},
            socket: { setTimeout: vi.fn() },
        } as unknown as IncomingMessage;
        const failed = new Response();
        const healthy = new Response();
        owner.accept(request, failed as unknown as ServerResponse);
        owner.accept(request, healthy as unknown as ServerResponse);
        failed.throwOnWrite = true;
        owner.onEvent(buildDispatchPayload({ index: 1 }));
        expect(warning).toHaveBeenCalledWith(
            expect.stringContaining('SSE write failed'),
            'errors',
            'test write failure',
        );
        expect(failed.destroyed).toBe(true);
        expect(healthy.frames.at(-1)).toContain('"index":1');
        owner.close('test finished');
    });
});
