import { APP_VERSION } from '@snowluma/common/version';
import { readRuntimeConfig, updateRuntimeConfig } from '@snowluma/common/runtime';
import {
    normalizeUpdateSourceConfig,
    type UpdateSourceConfig,
} from '@snowluma/common/update-source';

export const RELEASE_ROOT = 'https://github.com/SnowLuma/SnowLuma/releases';
export const DEFAULT_UPDATE_SOURCE: UpdateSourceConfig = {
    mode: 'auto',
    mirror: '',
    mirrors: [
        'https://ghfast.top',
        'https://ghproxy.net',
        'https://gh-proxy.com',
        'https://github.chenc.dev',
        'https://fastgit.cc',
        'https://gh.noki.icu',
        'https://cors.isteed.cc',
        'https://gh-proxy.org',
        'https://githubproxy.gohj99.site',
        'https://github.xxlab.tech',
    ],
};

export function readUpdateSource(): UpdateSourceConfig {
    return normalizeUpdateSourceConfig(readRuntimeConfig().updateSource ?? DEFAULT_UPDATE_SOURCE);
}

export function saveUpdateSource(value: unknown): UpdateSourceConfig {
    const config = normalizeUpdateSourceConfig(value);
    updateRuntimeConfig({ updateSource: config });
    return config;
}

export function sourceUrls(url: string, config: UpdateSourceConfig): string[] {
    if (config.mode === 'direct') {
        return [url];
    }

    if (config.mode === 'mirror') {
        return [`${config.mirror}/${url}`];
    }

    return [url, ...config.mirrors.map((mirror) => `${mirror}/${url}`)];
}

export interface MirrorProbeResult {
    mirror: string;
    available: boolean;
    latencyMs: number;
    error?: string;
}

export async function testUpdateSources(value: unknown): Promise<MirrorProbeResult[]> {
    const config = normalizeUpdateSourceConfig(value);
    const mirrors = [
        ...new Set(['', ...config.mirrors, ...(config.mirror ? [config.mirror] : [])]),
    ];
    const target = process.platform === 'win32' ? 'win-x64' : `linux-${process.arch}`;
    const extension = process.platform === 'win32' ? 'zip' : 'tar.gz';
    const probeUrl = `${RELEASE_ROOT}/download/v${APP_VERSION}/SnowLuma-v${APP_VERSION}-${target}-lite.${extension}`;
    const results = await Promise.all(
        mirrors.map(async (mirror): Promise<MirrorProbeResult> => {
            const start = performance.now();

            try {
                const response = await fetch(mirror ? `${mirror}/${probeUrl}` : probeUrl, {
                    headers: { Range: 'bytes=0-3' },
                    signal: AbortSignal.timeout(5_000),
                });

                if (!response.ok || !response.body) {
                    await response.body?.cancel();
                    throw new Error(`HTTP ${response.status}`);
                }

                if (/text\/html/i.test(response.headers.get('content-type') ?? '')) {
                    await response.body.cancel();
                    throw new Error('返回了 HTML 页面，而不是更新包');
                }

                const reader = response.body.getReader();
                const prefix: number[] = [];

                try {
                    while (prefix.length < 4) {
                        const { value, done } = await reader.read();

                        if (done) {
                            break;
                        }

                        prefix.push(...value.subarray(0, 4 - prefix.length));
                    }
                } finally {
                    await reader.cancel();
                    reader.releaseLock();
                }

                const signature = extension === 'zip' ? [0x50, 0x4b, 0x03, 0x04] : [0x1f, 0x8b];

                if (!signature.every((byte, index) => prefix[index] === byte)) {
                    throw new Error('返回内容不是有效的更新包');
                }

                return {
                    mirror,
                    available: true,
                    latencyMs: Math.round(performance.now() - start),
                };
            } catch (error) {
                return {
                    mirror,
                    available: false,
                    latencyMs: Math.round(performance.now() - start),
                    error: error instanceof Error ? error.message : String(error),
                };
            }
        }),
    );
    return results.sort(
        (a, b) => Number(b.available) - Number(a.available) || a.latencyMs - b.latencyMs,
    );
}
