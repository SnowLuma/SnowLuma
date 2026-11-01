import { afterEach, describe, expect, it, vi } from 'vitest';

import {
    DEFAULT_HTTP_DOWNLOAD_TIMEOUT_MS,
    DEFAULT_MAX_BINARY_DOWNLOAD_BYTES,
    httpDownloadTimeoutMs,
    maxBinaryDownloadBytes,
} from '../src/highway/download-settings';
import { downloadHttp } from '../src/highway/utils';

const memorySink = (): {
    write: () => void;
    done: () => undefined;
    discard: () => void;
} => ({ write: () => undefined, done: () => undefined, discard: () => undefined });

afterEach(() => {
    vi.unstubAllEnvs();
    vi.unstubAllGlobals();
    vi.restoreAllMocks();
});

describe('highway download settings', () => {
    it('keeps the documented defaults when nothing is configured', () => {
        expect(httpDownloadTimeoutMs({})).toBe(60_000);
        expect(maxBinaryDownloadBytes({})).toBe(1024 * 1024 * 1024);
        expect(DEFAULT_HTTP_DOWNLOAD_TIMEOUT_MS).toBe(60_000);
        expect(DEFAULT_MAX_BINARY_DOWNLOAD_BYTES).toBe(1024 * 1024 * 1024);
    });

    it('reads both knobs from the environment', () => {
        expect(httpDownloadTimeoutMs({ SNOWLUMA_HTTP_DOWNLOAD_TIMEOUT_MS: '180000' })).toBe(
            180_000,
        );
        expect(
            maxBinaryDownloadBytes({ SNOWLUMA_MAX_BINARY_DOWNLOAD_BYTES: String(2 ** 31) }),
        ).toBe(2 ** 31);
    });

    it('ignores unusable values instead of failing the download', () => {
        expect(httpDownloadTimeoutMs({ SNOWLUMA_HTTP_DOWNLOAD_TIMEOUT_MS: '0' })).toBe(60_000);
        expect(httpDownloadTimeoutMs({ SNOWLUMA_HTTP_DOWNLOAD_TIMEOUT_MS: 'soon' })).toBe(60_000);
        expect(maxBinaryDownloadBytes({ SNOWLUMA_MAX_BINARY_DOWNLOAD_BYTES: '-5' })).toBe(
            DEFAULT_MAX_BINARY_DOWNLOAD_BYTES,
        );
    });

    it('feeds the configured timeout into the fetch signal', async () => {
        vi.stubEnv('SNOWLUMA_HTTP_DOWNLOAD_TIMEOUT_MS', '1234');
        const timeoutSpy = vi.spyOn(AbortSignal, 'timeout');
        const fetchStub = vi.fn(
            async () => new Response(new Uint8Array([1, 2, 3]), { status: 200 }),
        );
        vi.stubGlobal('fetch', fetchStub);

        await downloadHttp('https://example.test/media.bin', 'media', 1024, memorySink);

        expect(timeoutSpy).toHaveBeenCalledWith(1234);
        expect(fetchStub).toHaveBeenCalledTimes(1);
    });
});
