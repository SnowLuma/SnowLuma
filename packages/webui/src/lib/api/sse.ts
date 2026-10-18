import { ApiError } from './types';

const MAX_FRAME_CHARS = 1024 * 1024;

function createFrameDecoder() {
    let line = '';
    let data: string[] = [];
    let frameChars = 0;
    let skipLf = false;

    return function* (chunk: string): Generator<string> {
        for (const char of chunk) {
            if (skipLf) {
                skipLf = false;

                if (char === '\n') {
                    continue;
                }
            }

            frameChars += char.length;

            if (frameChars > MAX_FRAME_CHARS) {
                throw new ApiError(502, '实时数据帧过大', 'INVALID_RESPONSE');
            }

            if (char !== '\r' && char !== '\n') {
                line += char;
                continue;
            }

            skipLf = char === '\r';

            if (line === '') {
                const frame = data.join('\n');
                data = [];
                frameChars = 0;

                if (frame) {
                    yield frame;
                }
            } else if (line.startsWith('data:')) {
                const value = line.slice(5);
                data.push(value.startsWith(' ') ? value.slice(1) : value);
            } else if (line === 'data') {
                data.push('');
            }

            line = '';
        }
    };
}

/** Read JSON data frames; incomplete events at EOF are discarded per SSE. */
export async function* readSseJson<T>(
    body: ReadableStream<Uint8Array>,
    signal?: AbortSignal,
): AsyncGenerator<T> {
    const reader = body.getReader();
    const decoder = new TextDecoder();
    const decodeFrames = createFrameDecoder();
    let cancellation: Promise<void> | undefined;

    const cancel = () => {
        // A failed body read also rejects cancel; preserve the original read error.
        cancellation ??= reader.cancel().catch(() => {});
    };

    signal?.addEventListener('abort', cancel, { once: true });

    try {
        signal?.throwIfAborted();

        for (;;) {
            const { done, value } = await reader.read();
            signal?.throwIfAborted();

            for (const data of decodeFrames(decoder.decode(value, { stream: !done }))) {
                signal?.throwIfAborted();
                let parsed: T;

                try {
                    parsed = JSON.parse(data) as T;
                } catch {
                    throw new ApiError(502, '实时数据格式无效', 'INVALID_RESPONSE');
                }

                yield parsed;
            }

            if (done) {
                return;
            }
        }
    } finally {
        signal?.removeEventListener('abort', cancel);
        cancel();
        await cancellation;
        reader.releaseLock();
    }
}
