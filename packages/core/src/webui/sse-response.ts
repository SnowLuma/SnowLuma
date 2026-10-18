import { createLogger } from '@snowluma/common/logger';

const log = createLogger('WebUI.SSE');

export interface SseChannel {
    raw(chunk: Uint8Array): void;
    encode(s: string): Uint8Array;
    send(payload: unknown): void;
    onClose(cleanup: () => void): void;
    close(): void;
    isClosed(): boolean;
    desiredSize(): number | null;
}

/** Owns stream cancellation, subscriptions and the keep-alive timer. */
export function sseResponse(
    request: AbortSignal,
    start: (channel: SseChannel) => void,
    shutdown?: AbortSignal,
): Response {
    const signal = shutdown ? AbortSignal.any([request, shutdown]) : request;
    let cancel!: () => void;
    const stream = new ReadableStream<Uint8Array>({
        start(controller) {
            const encoder = new TextEncoder();
            let closed = false;
            let heartbeat: ReturnType<typeof setInterval> | undefined;
            const cleanups: Array<() => void> = [];

            const cleanup = (fn: () => void) => {
                try {
                    fn();
                } catch (error) {
                    log.warn('stream cleanup failed: %s', error);
                }
            };

            const teardown = (closeStream = true) => {
                if (closed) {
                    return;
                }

                closed = true;
                clearInterval(heartbeat);
                signal.removeEventListener('abort', onAbort);

                if (closeStream) {
                    controller.close();
                }

                cleanups.splice(0).forEach(cleanup);
            };

            const onAbort = () => teardown();
            cancel = () => teardown(false);
            signal.addEventListener('abort', onAbort, { once: true });

            if (signal.aborted) {
                teardown();
                return;
            }

            const raw = (chunk: Uint8Array) => {
                if (!closed) {
                    controller.enqueue(chunk);
                }
            };

            const channel: SseChannel = {
                raw,
                encode: (text) => encoder.encode(text),
                send: (payload) => {
                    if (!closed) {
                        raw(encoder.encode(`data: ${JSON.stringify(payload)}\n\n`));
                    }
                },
                onClose: (fn) => {
                    if (closed) {
                        cleanup(fn);
                    } else {
                        cleanups.push(fn);
                    }
                },
                close: () => teardown(),
                isClosed: () => closed,
                desiredSize: () => controller.desiredSize,
            };

            try {
                start(channel);

                if (!closed) {
                    heartbeat = setInterval(() => raw(encoder.encode(': heartbeat\n\n')), 15000);
                }
            } catch (error) {
                teardown();
                throw error;
            }
        },
        cancel() {
            cancel();
        },
    });
    return new Response(stream, {
        headers: {
            'Content-Type': 'text/event-stream',
            'Cache-Control': 'no-cache',
            Connection: 'keep-alive',
        },
    });
}
