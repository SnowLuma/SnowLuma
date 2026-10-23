import { openAsBlob } from 'node:fs';
import { stat } from 'node:fs/promises';
import { basename, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { NamedMediaSource } from '../types/index.js';

/** Opens a file-backed source without buffering the entire file in memory.
 * Keep the file unchanged until the send finishes; read failures are propagated. */
export async function localFile(path: string | URL): Promise<NamedMediaSource> {
    const absolutePath = path instanceof URL ? fileURLToPath(path) : resolve(path);
    const info = await stat(absolutePath);

    if (!info.isFile()) {
        throw new TypeError('localFile() requires a regular file');
    }

    return { source: await openAsBlob(absolutePath), filename: basename(absolutePath) };
}
