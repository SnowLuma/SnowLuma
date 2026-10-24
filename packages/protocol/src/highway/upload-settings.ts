/** Deployment-wide policy. Each video snapshots it before preparing its bytes. */
let videoUploadConcurrency = 1;

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
