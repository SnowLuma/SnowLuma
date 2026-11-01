import { positiveIntEnv } from '@snowluma/common/env';

/** Default timeout for one HTTP media download attempt (ms). */
export const DEFAULT_HTTP_DOWNLOAD_TIMEOUT_MS = 60_000;

/** Default cap on one binary load that is buffered in memory (bytes). */
export const DEFAULT_MAX_BINARY_DOWNLOAD_BYTES = 1024 * 1024 * 1024;

/** Node's timer ceiling; a larger value would be silently clamped anyway. */
const MAX_TIMER_MS = 2_147_483_647;

/**
 * Deliberate ceiling for the configurable cap. It is not a Node limit (Node 24
 * reports `buffer.constants.MAX_LENGTH` as `Number.MAX_SAFE_INTEGER`); buffering a
 * single download larger than this is not a realistic media source and would
 * exhaust the process long before it completes.
 */
const MAX_BINARY_DOWNLOAD_BYTES = 4 * 1024 * 1024 * 1024;

/**
 * Timeout for one HTTP media download attempt.
 *
 * Deployment-wide rather than per-adapter because every caller reaches this
 * through the same download engine (`loadBinarySource` / `stageSourceToDisk`),
 * and it is configured the same way as the other transport timeouts
 * (`SNOWLUMA_PACKET_TIMEOUT_MS`, `SNOWLUMA_HOOK_ACK_TIMEOUT_MS`) instead of
 * growing the per-account OneBot config surface.
 *
 * The 60 s default is generous for images but tight for a large media file over
 * a slow link, where the abort is reported as a generic fetch failure.
 *
 * Not to be confused with `SNOWLUMA_DOWNLOAD_FILE_TIMEOUT_MS`, which bounds the
 * `download_file` OneBot action's own staging.
 */
export function httpDownloadTimeoutMs(env: NodeJS.ProcessEnv = process.env): number {
    return positiveIntEnv('SNOWLUMA_HTTP_DOWNLOAD_TIMEOUT_MS', DEFAULT_HTTP_DOWNLOAD_TIMEOUT_MS, {
        env,
        max: MAX_TIMER_MS,
    });
}

/**
 * Cap on one binary source loaded fully into memory.
 *
 * Applies to the helpers whose size bound is implicit (image, voice, avatar,
 * custom face, group-notice image). Callers that pass their own ceiling — group
 * files, flash transfer, video — keep it, so raising this never lifts those.
 */
export function maxBinaryDownloadBytes(env: NodeJS.ProcessEnv = process.env): number {
    return positiveIntEnv('SNOWLUMA_MAX_BINARY_DOWNLOAD_BYTES', DEFAULT_MAX_BINARY_DOWNLOAD_BYTES, {
        env,
        max: MAX_BINARY_DOWNLOAD_BYTES,
    });
}
