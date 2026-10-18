import { existsSync } from 'node:fs';
import { mkdir, rename, rm } from 'node:fs/promises';
import path from 'node:path';
import { createLogger } from '@snowluma/common/logger';
import { parseVersion } from '@snowluma/common/semver';
import { downloadUpdate } from './download';
import { exists, MANIFEST_FILE, readManifest, updateDirectory } from './files';

const log = createLogger('Update');

export type UpdateState =
    | { phase: 'unavailable'; message: string }
    | { phase: 'idle' }
    | { phase: 'downloading' | 'ready' | 'restarting'; version: string }
    | { phase: 'error'; message: string };

export async function createUpdateService(
    root: string | undefined,
    current: string,
    options: { download?: typeof downloadUpdate; isContainer?: boolean } = {},
) {
    const download = options.download ?? downloadUpdate;
    let state: UpdateState;
    let target = '';
    let staging = '';

    if (!root || !existsSync(path.join(root, MANIFEST_FILE))) {
        state = { phase: 'unavailable', message: '在线更新仅支持发行包' };
    } else if (
        options.isContainer ??
        (existsSync('/.dockerenv') || Boolean(process.env.container))
    ) {
        state = { phase: 'unavailable', message: '请更新容器镜像' };
    } else {
        const manifest = await readManifest(root);
        target = manifest.target;
        staging = await updateDirectory(root);
        const pending = path.join(staging, 'pending', 'payload');
        state = (await exists(pending))
            ? { phase: 'ready', version: (await readManifest(pending)).version }
            : { phase: 'idle' };
    }

    const prepare = async (version: string): Promise<void> => {
        const directory = path.join(staging, 'downloading');

        try {
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
        start(version: unknown) {
            if (state.phase !== 'idle' && state.phase !== 'error') {
                throw new Error(
                    state.phase === 'unavailable' ? state.message : '更新正在进行或等待重启',
                );
            }

            const parsed = parseVersion(version);

            if (!parsed || parsed.prerelease.length || parsed.compare(current) <= 0) {
                throw new Error('请选择更新的正式版本');
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
