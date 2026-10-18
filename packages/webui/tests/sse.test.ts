import { describe, expect, it } from 'vitest';
import { readSseJson } from '../src/lib/api/sse';

const encoder = new TextEncoder();

async function read(chunks: Uint8Array[]): Promise<unknown[]> {
    const body = new ReadableStream<Uint8Array>({
        start(controller) {
            for (const chunk of chunks) {
                controller.enqueue(chunk);
            }

            controller.close();
        },
    });
    const frames: unknown[] = [];

    for await (const frame of readSseJson(body)) {
        frames.push(frame);
    }

    return frames;
}

describe('SSE JSON reader', () => {
    it.each(['\n', '\r\n', '\r'])('handles fragmented UTF-8 and %j line endings', async (eol) => {
        const bytes = encoder.encode(
            `: heartbeat${eol}data: {"text":${eol}data: "中文"}${eol}${eol}`,
        );
        expect(await read(Array.from(bytes, (byte) => Uint8Array.of(byte)))).toEqual([
            { text: '中文' },
        ]);
    });

    it('discards an incomplete event at EOF', async () => {
        expect(await read([encoder.encode('data: {"unfinished":true}\n')])).toEqual([]);
    });

    it('limits individual frames rather than the size of a network chunk', async () => {
        const frame = 'data: ' + JSON.stringify({ text: 'x'.repeat(600_000) }) + '\n\n';
        expect(await read([encoder.encode(frame.repeat(2))])).toHaveLength(2);
        await expect(
            read([encoder.encode('data: ' + 'x'.repeat(1024 * 1024))]),
        ).rejects.toMatchObject({ code: 'INVALID_RESPONSE' });
    });

    it('reports malformed JSON instead of treating the operation as successful', async () => {
        await expect(read([encoder.encode('data: broken\n\n')])).rejects.toMatchObject({
            code: 'INVALID_RESPONSE',
        });
    });

    it('cancels a pending read and releases the lock on abort', async () => {
        let cancelled = false;
        const body = new ReadableStream<Uint8Array>({
            cancel() {
                cancelled = true;
            },
        });
        const controller = new AbortController();
        const reader = readSseJson(body, controller.signal);
        const result = reader.next();
        controller.abort();
        await expect(result).rejects.toMatchObject({ name: 'AbortError' });
        expect(cancelled).toBe(true);
        expect(body.locked).toBe(false);
    });
});
