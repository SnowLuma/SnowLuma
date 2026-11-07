import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@snowluma/common/logger';
import { parseVersion } from '@snowluma/common/semver';
import { downloadUpdate } from './download';
import {
    assertUpdateWritable,
    exists,
    MANIFEST_FILE,
    readManifest,
    updateDirectory,
} from './files';
import { hasUpdateLauncher } from './startup';
import { getReleaseVersions } from './versions';

const log = createLogger('Update');

export type UpdateState =
    | { phase: 'unavailable'; message: string }
    | { phase: 'idle' }
    | { phase: 'downloading' | 'ready' | 'restarting'; version: string }
    | { phase: 'error'; message: string };

export async function createUpdateService(
    root: string | undefined,
    current: string,
    options: { download?: typeof downloadUpdate; restartAvailable?: boolean } = {},
) {
    const download = options.download ?? downloadUpdate;
    let state: UpdateState;
    let target = '';
    let staging = '';

    state = { phase: 'unavailable', message: '在线更新仅支持发行包' };

    try {
        if (root && (await exists(path.join(root, MANIFEST_FILE)))) {
            const manifest = await readManifest(root);
            target = manifest.target;

            if (!(options.restartAvailable ?? hasUpdateLauncher(root))) {
                state = { phase: 'unavailable', message: '在线更新需要通过发行包启动器运行' };
            } else {
                await assertUpdateWritable(root, manifest);
                staging = await updateDirectory(root);
                const pending = path.join(staging, 'pending', 'payload');

                if (await exists(pending)) {
                    const next = await readManifest(pending);

                    if (next.target !== target) {
                        throw new Error('更新包平台不匹配');
                    }

                    state = { phase: 'ready', version: next.version };
                } else {
                    state = { phase: 'idle' };
                }
            }
        }
    } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.error('在线更新不可用: %s', error);
        state = {
            phase: 'unavailable',
            message: `在线更新不可用，请检查程序目录和暂存目录的读写权限及发行包完整性: ${message}`,
        };
    }

    const prepare = async (version: string): Promise<void> => {
        const directory = path.join(staging, 'downloading');

        try {
            if (!root) {
                throw new Error('在线更新仅支持发行包');
            }

            await assertUpdateWritable(root, await readManifest(root));
            await rm(directory, { recursive: true, force: true });
            await mkdir(directory, { recursive: true });
            await download(directory, version, target);
            await rm(path.join(directory, 'archive'));
            await rename(directory, path.join(staging, 'pending'));
            state = { phase: 'ready', version };
            log.info('v%s 已下载，重启后应用', version);
        } catch (error) {
            log.error('下载更新失败: %s', error);
            let message = error instanceof Error ? error.message : String(error);

            try {
                await rm(directory, { recursive: true, force: true });
            } catch (cleanupError) {
                message += `；清理更新文件失败: ${String(cleanupError)}`;
                log.error('清理更新文件失败: %s', cleanupError);
            }

            state = { phase: 'error', message };
        }
    };

    return {
        status: () => ({ current, ...state }),
        releases(page = 1, force = false) {
            return getReleaseVersions(current, target || null, page, force);
        },
        start(version: unknown, options: { allowDowngrade?: unknown } = {}) {
            if (state.phase !== 'idle' && state.phase !== 'error') {
                throw new Error(
                    state.phase === 'unavailable' ? state.message : '更新正在进行或等待重启',
                );
            }

            const parsed = parseVersion(version);

            if (!parsed) {
                throw new Error('请选择有效的版本号');
            }

            if (
                options.allowDowngrade !== undefined &&
                typeof options.allowDowngrade !== 'boolean'
            ) {
                throw new Error('allowDowngrade 必须是布尔值');
            }

            if (parsed.compare(current) < 0 && options.allowDowngrade !== true) {
                throw new Error('降级需要明确确认，旧版本可能无法读取新版本数据');
            }

            state = { phase: 'downloading', version: parsed.raw };
            log.info('下载 v%s', parsed.raw);
            void prepare(parsed.raw);
        },
        restart() {
            if (state.phase !== 'ready') {
                throw new Error('更新包尚未就绪');
            }

            state = { phase: 'restarting', version: state.version };
        },
    };
}

export type UpdateService = Awaited<ReturnType<typeof createUpdateService>>;
