import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { Readable, Transform } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { unzipSync } from 'fflate';
import { x as extractTar } from 'tar';
import { isRuntimeEntry, readManifest } from './files';

interface ReleaseAsset {
    url: string;
    size: number;
    digest: string;
}

export function assetName(version: string, target: string): string {
    const platform = target.replace('win32', 'win');
    return `SnowLuma-v${version}-${platform}-lite.${target.startsWith('win32') ? 'zip' : 'tar.gz'}`;
}

async function releaseAsset(version: string, target: string): Promise<ReleaseAsset> {
    const name = assetName(version, target);
    const response = await fetch(
        `https://api.github.com/repos/SnowLuma/SnowLuma/releases/tags/v${version}`,
        {
            headers: {
                Accept: 'application/vnd.github+json',
                'User-Agent': 'SnowLuma',
                'X-GitHub-Api-Version': '2022-11-28',
            },
            signal: AbortSignal.timeout(15_000),
        },
    );

    if (!response.ok) {
        throw new Error(`获取更新失败: GitHub ${response.status}`);
    }

    const release: unknown = await response.json();

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
        typeof asset.size !== 'number' ||
        !Number.isSafeInteger(asset.size) ||
        asset.size <= 0 ||
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
): Promise<void> {
    const asset = await releaseAsset(version, target);
    const response = await fetch(asset.url, { signal: AbortSignal.timeout(10 * 60_000) });

    if (!response.ok || !response.body) {
        throw new Error(`下载更新失败: HTTP ${response.status}`);
    }

    const archive = path.join(directory, 'archive');
    const hash = createHash('sha256');
    let received = 0;
    await pipeline(
        Readable.fromWeb(response.body),
        new Transform({
            transform(chunk: Buffer, _encoding, callback) {
                received += chunk.length;

                if (received > asset.size) {
                    callback(new Error('更新包大小不匹配'));
                    return;
                }

                hash.update(chunk);
                callback(null, chunk);
            },
        }),
        createWriteStream(archive, { flags: 'wx' }),
    );

    if (received !== asset.size || `sha256:${hash.digest('hex')}` !== asset.digest) {
        throw new Error('更新包校验失败');
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
