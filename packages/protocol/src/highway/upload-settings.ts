/** Deployment-wide policy. Each video snapshots it before preparing its bytes. */
let videoUploadConcurrency = 1;

export interface HighwayUploadTimeouts {
    idleMs: number;
    totalMs: number;
}

/** Snapshot once per file; a deployment change must not alter an in-flight upload. */
export function highwayUploadTimeouts(env: NodeJS.ProcessEnv = process.env): HighwayUploadTimeouts {
    const read = (name: string, defaultMs: number): number => {
        const raw = env[name];

        if (raw === undefined) {
            return defaultMs;
        }

        const value = raw.trim();
        const parsed = /^[1-9]\d*$/.test(value) ? Number(value) : Number.NaN;

        if (!Number.isSafeInteger(parsed) || parsed > 2_147_483_647) {
            throw new RangeError(`${name} must be an integer from 1 to 2147483647 milliseconds`);
        }

        return parsed;
    };

    return {
        idleMs: read('SNOWLUMA_HIGHWAY_UPLOAD_IDLE_TIMEOUT_MS', 30_000),
        totalMs: read('SNOWLUMA_HIGHWAY_UPLOAD_TIMEOUT_MS', 30 * 60_000),
    };
}

export function validateUploadConcurrency(value: unknown): number {
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1 || value > 4) {
        throw new RangeError('videoUploadConcurrency must be an integer from 1 to 4');
    }

    return value;
}

export function setVideoUploadConcurrency(value: number): void {
    videoUploadConcurrency = validateUploadConcurrency(value);
}

export function getVideoUploadConcurrency(): number {
    return videoUploadConcurrency;
}
