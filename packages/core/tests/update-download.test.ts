import { createHash } from 'node:crypto';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { zipSync } from 'fflate';
import { c as createTar } from 'tar';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { archivePath, assetName, downloadUpdate as download } from '../src/update/download';
import { readManifest } from '../src/update/files';
import { releaseFixture } from './helpers/update-fixture';

const direct = { mode: 'direct', mirror: '', mirrors: [] } as const;
const downloadUpdate = (directory: string, version: string, target: string) =>
    download(directory, version, target, { ...direct, mirrors: [] });

let root: string;
beforeEach(async () => {
    root = await mkdtemp(path.join(os.tmpdir(), 'snowluma-download-test-'));
});
afterEach(async () => {
    vi.unstubAllGlobals();
    await rm(root, { recursive: true, force: true });
});

function mockRelease(bytes: Uint8Array, target: string, digest?: string) {
    const name = assetName('2.0.0', target);
    const url = `https://github.com/SnowLuma/SnowLuma/releases/download/v2.0.0/${name}`;
    const fetchMock = vi.fn(async (input: string | URL | Request) => {
        if (String(input).startsWith('https://api.github.com/')) {
            return Response.json({
                assets: [
                    {
                        name,
                        size: bytes.length,
                        digest:
                            digest ?? `sha256:${createHash('sha256').update(bytes).digest('hex')}`,
                    },
                ],
            });
        }

        expect(input).toBe(url);
        return new Response(new Uint8Array(bytes));
    });
    vi.stubGlobal('fetch', fetchMock);
    return fetchMock;
}

describe('release downloads', () => {
    it.each(['403', 'html', 'corrupt', 'interrupted'])(
        'cleans and retries a %s response through a mirror using HTML release checksums',
        async (failure) => {
            const manifest = await releaseFixture(path.join(root, 'source'), '2.0.0', 'win32-x64');
            const bytes = zipSync({
                'release.json': new TextEncoder().encode(JSON.stringify(manifest)),
                'app.mjs': new TextEncoder().encode('verified payload'),
            });
            const name = assetName('2.0.0', 'win32-x64');
            const digest = createHash('sha256').update(bytes).digest('hex');
            const fetchMock = vi.fn<typeof fetch>(async (input) => {
                const url = String(input);

                if (url.includes('api.github.com')) {
                    return new Response('rate limited', { status: 403 });
                }

                if (url.includes('/expanded_assets/')) {
                    return new Response(
                        `<li><a href="/SnowLuma/SnowLuma/releases/download/v2.0.0/${name}">asset</a><clipboard-copy value="sha256:${digest}"></clipboard-copy></li>`,
                    );
                }

                if (url.startsWith('https://working.example/')) {
                    // Mirrors may stream a verified archive without Content-Length.
                    return new Response(new Uint8Array(bytes));
                }

                if (failure === '403') {
                    return new Response('blocked', { status: 403 });
                }

                if (failure === 'html') {
                    return new Response('<html>challenge</html>', {
                        headers: { 'Content-Type': 'text/html' },
                    });
                }

                if (failure === 'interrupted') {
                    let sent = false;
                    return new Response(
                        new ReadableStream({
                            pull(controller) {
                                if (sent) {
                                    controller.error(new Error('connection reset'));
                                } else {
                                    controller.enqueue(new Uint8Array([1, 2, 3]));
                                    sent = true;
                                }
                            },
                        }),
                    );
                }

                return new Response('corrupt archive');
            });
            vi.stubGlobal('fetch', fetchMock);
            await download(root, '2.0.0', 'win32-x64', {
                mode: 'auto',
                mirror: '',
                mirrors: ['https://working.example'],
            });
            expect(await readFile(path.join(root, 'archive'))).toEqual(Buffer.from(bytes));
            expect(await readFile(path.join(root, 'payload/app.mjs'), 'utf8')).toBe(
                'verified payload',
            );
            expect(
                fetchMock.mock.calls
                    .filter(([url]) => String(url).includes('/download/'))
                    .map(([url]) => String(url)),
            ).toEqual([
                `https://github.com/SnowLuma/SnowLuma/releases/download/v2.0.0/${name}`,
                `https://working.example/https://github.com/SnowLuma/SnowLuma/releases/download/v2.0.0/${name}`,
            ]);
        },
    );

    it('does not try other download sources in pinned mode', async () => {
        const bytes = new Uint8Array([1, 2, 3]);
        const fetchMock = mockRelease(bytes, 'win32-x64');
        const original = fetchMock.getMockImplementation()!;
        fetchMock.mockImplementation(async (input) =>
            String(input).includes('api.github.com')
                ? original(input)
                : new Response('blocked', { status: 403 }),
        );
        await expect(
            download(root, '2.0.0', 'win32-x64', {
                mode: 'mirror',
                mirror: 'https://pinned.example',
                mirrors: ['https://other.example'],
            }),
        ).rejects.toThrow('HTTP 403');
        expect(fetchMock.mock.calls.map(([url]) => url)).toEqual([
            'https://api.github.com/repos/SnowLuma/SnowLuma/releases/tags/v2.0.0',
            `https://pinned.example/https://github.com/SnowLuma/SnowLuma/releases/download/v2.0.0/${assetName('2.0.0', 'win32-x64')}`,
        ]);
        expect(await readdir(root)).toEqual([]);
    });
    it.each(['win32-x64', 'linux-x64', 'linux-arm64'])(
        'downloads and validates the %s lite package',
        async (target) => {
            const source = path.join(root, 'source');
            await releaseFixture(source, '2.0.0', target);
            let bytes: Uint8Array;

            if (target === 'win32-x64') {
                const files: Record<string, Uint8Array> = {};

                const scan = async (directory: string) => {
                    for (const entry of await readdir(directory, { withFileTypes: true })) {
                        const file = path.join(directory, entry.name);

                        if (entry.isDirectory()) {
                            await scan(file);
                        } else {
                            files[path.relative(source, file).replaceAll('\\', '/')] =
                                await readFile(file);
                        }
                    }
                };

                await scan(source);
                bytes = zipSync(files);
            } else {
                const archive = path.join(root, 'fixture.tar.gz');
                await createTar({ file: archive, cwd: source, gzip: true }, ['.']);
                bytes = await readFile(archive);
            }

            mockRelease(bytes, target);
            await downloadUpdate(root, '2.0.0', target);
            expect((await readManifest(path.join(root, 'payload'))).target).toBe(target);
            expect(await readFile(path.join(root, 'payload/client/index.html'), 'utf8')).toBe(
                '2.0.0',
            );
        },
    );

    it('rejects a digest mismatch before extracting', async () => {
        mockRelease(
            new TextEncoder().encode('bad archive'),
            'win32-x64',
            `sha256:${'0'.repeat(64)}`,
        );
        await expect(downloadUpdate(root, '2.0.0', 'win32-x64')).rejects.toThrow('校验失败');
        expect(await readdir(root)).toEqual(['archive']);
    });

    it('rejects path traversal in a zip before writing payload files', async () => {
        mockRelease(zipSync({ '../outside': new Uint8Array([1]) }), 'win32-x64');
        await expect(downloadUpdate(root, '2.0.0', 'win32-x64')).rejects.toThrow('路径无效');
        expect(await readdir(path.join(root, 'payload'))).toEqual([]);
    });

    it('reports HTTP failures', async () => {
        vi.stubGlobal(
            'fetch',
            vi.fn(async () => new Response('rate limited', { status: 403 })),
        );
        await expect(downloadUpdate(root, '2.0.0', 'win32-x64')).rejects.toThrow('GitHub 403');
    });

    it.each([
        '../data',
        '/app.mjs',
        'native/../../data',
        'native/../data',
        'native/C:evil',
        'native\\..\\data',
        'config/runtime.json',
    ])('rejects unsafe archive path %s', (name) => {
        expect(() => archivePath(name)).toThrow('路径无效');
    });

    it('accepts the root-relative layout used by Linux release archives', () => {
        expect(archivePath('./')).toBe('');
        expect(archivePath('./native/binding.node')).toBe('native/binding.node');
    });

    it.each([
        ['1.0.0', 'win32-x64'],
        ['2.0.0', 'linux-x64'],
    ])('rejects a package for version %s and target %s', async (version, target) => {
        const manifest = await releaseFixture(path.join(root, 'source'), version, target);
        const bytes = zipSync({
            'release.json': new TextEncoder().encode(JSON.stringify(manifest)),
        });
        mockRelease(bytes, 'win32-x64');
        await expect(downloadUpdate(root, '2.0.0', 'win32-x64')).rejects.toThrow(
            '版本或平台不匹配',
        );
    });
});
