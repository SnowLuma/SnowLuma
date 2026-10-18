import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, rm } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import { x as extractTar } from 'tar';
import { isRuntimeEntry, readManifest } from './files';
import { assetName, fetchRelease } from './release';
export { assetName } from './release';
import { readUpdateSource, sourceUrls } from './sources';
import type { UpdateSourceConfig } from '@snowluma/common/update-source';

interface ReleaseAsset {
    url: string;
    size: number | null;
    digest: string;
}

async function releaseAsset(
    version: string,
    target: string,
    source: UpdateSourceConfig,
): Promise<ReleaseAsset> {
    const name = assetName(version, target);
    const { data: release, fromPage } = await fetchRelease(version, source);

    if (
        !release ||
        typeof release !== 'object' ||
        !('assets' in release) ||
        !Array.isArray(release.assets)
    ) {
        throw new Error('发布信息无效');
    }

    const asset: unknown = release.assets.find(
        (item: unknown) =>
            item !== null && typeof item === 'object' && 'name' in item && item.name === name,
    );
    const url = `https://github.com/SnowLuma/SnowLuma/releases/download/v${version}/${name}`;

    if (
        !asset ||
        typeof asset !== 'object' ||
        !('size' in asset) ||
        !(
            (fromPage && asset.size === null) ||
            (typeof asset.size === 'number' && Number.isSafeInteger(asset.size) && asset.size > 0)
        ) ||
        !('digest' in asset) ||
        typeof asset.digest !== 'string' ||
        !/^sha256:[a-f0-9]{64}$/.test(asset.digest)
    ) {
        throw new Error('更新包不存在或缺少校验信息');
    }

    return { url, size: asset.size, digest: asset.digest };
}

export function archivePath(name: string): string {
    const normalized = name.replaceAll('\\', '/').replace(/^\.\//, '').replace(/\/$/, '');

    if (normalized === '.' || normalized === '') {
        return '';
    }

    const parts = normalized.split('/');

    if (
        !isRuntimeEntry(parts[0]) ||
        parts.some((part) => !part || part === '.' || part === '..' || /[:\0]/.test(part))
    ) {
        throw new Error(`更新包路径无效: ${name}`);
    }

    return normalized;
}

export async function downloadUpdate(
    directory: string,
    version: string,
    target: string,
    source = readUpdateSource(),
): Promise<void> {
    const asset = await releaseAsset(version, target, source);
    const archive = path.join(directory, 'archive');
    const urls = sourceUrls(asset.url, source);
    const failures: string[] = [];

    for (const [index, url] of urls.entries()) {
        let created = false;

        try {
            const headersTimeout = new AbortController();
            const timer = setTimeout(() => headersTimeout.abort(), 8_000);
            let response: Response;

            try {
                response = await fetch(url, {
                    signal: AbortSignal.any([
                        headersTimeout.signal,
                        AbortSignal.timeout(10 * 60_000),
                    ]),
                });
            } finally {
                clearTimeout(timer);
            }

            if (!response.ok || !response.body) {
                await response.body?.cancel();
                throw new Error(`下载更新失败: HTTP ${response.status}`);
            }

            if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
                await response.body.cancel();
                throw new Error('下载源返回了 HTML 页面，而不是更新包');
            }

            const hash = createHash('sha256');
            const length = response.headers.get('content-length');
            const size =
                asset.size ?? (length === null ? null : /^\d+$/.test(length) ? Number(length) : 0);

            if (size !== null && (!Number.isSafeInteger(size) || size <= 0)) {
                await response.body.cancel();
                throw new Error('下载源返回了无效的更新包大小');
            }

            let received = 0;
            const output = createWriteStream(archive, { flags: 'wx' });
            output.once('open', () => {
                created = true;
            });
            await pipeline(
                Readable.fromWeb(response.body),
                new Transform({
                    transform(chunk: Buffer, _encoding, callback) {
                        received += chunk.length;

                        if (received > (size ?? 256 * 1024 * 1024)) {
                            callback(new Error('更新包大小不匹配'));
                            return;
                        }

                        hash.update(chunk);
                        callback(null, chunk);
                    },
                }),
                output,
            );

            if (
                (size !== null && received !== size) ||
                `sha256:${hash.digest('hex')}` !== asset.digest
            ) {
                throw new Error('更新包校验失败');
            }

            break;
        } catch (error) {
            if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
                throw error;
            }

            failures.push(error instanceof Error ? error.message : String(error));

            if (index === urls.length - 1) {
                throw new Error([...new Set(failures)].join('；'));
            }

            if (created) {
                await rm(archive);
            }
        }
    }

    const payload = path.join(directory, 'payload');
    await mkdir(payload);

    if (target.startsWith('win32')) {
        const files = unzipSync(await readFile(archive), {
            filter: (entry) => {
                archivePath(entry.name);
                return true;
            },
        });

        for (const [name, bytes] of Object.entries(files)) {
            const relative = archivePath(name);

            if (!relative || name.endsWith('/')) {
                continue;
            }

            const destination = path.join(payload, relative);
            await mkdir(path.dirname(destination), { recursive: true });
            await writeFile(destination, bytes, { flag: 'wx' });
        }
    } else {
        let invalidEntry: Error | undefined;
        await extractTar({
            file: archive,
            cwd: payload,
            strict: true,
            filter: (name, entry) => {
                try {
                    archivePath(name);

                    if (
                        !('type' in entry) ||
                        (entry.type !== 'File' && entry.type !== 'Directory')
                    ) {
                        throw new Error('更新包包含链接或特殊文件');
                    }

                    return true;
                } catch (error) {
                    invalidEntry = error instanceof Error ? error : new Error(String(error));
                    return false;
                }
            },
        });

        if (invalidEntry) {
            throw invalidEntry;
        }
    }

    const manifest = await readManifest(payload);

    if (manifest.version !== version || manifest.target !== target) {
        throw new Error('更新包版本或平台不匹配');
    }
}
