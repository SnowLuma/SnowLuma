import { spawn } from 'node:child_process';
import path from 'node:path';
import { applyPendingUpdate } from './files';

export const RESTART_EXIT_CODE = 75;

export async function runApplication(root: string): Promise<void> {
    let stopping = false;
    let child: ReturnType<typeof spawn> | undefined;

    const requestShutdown = () => {
        if (child?.connected) {
            child.send('shutdown', (error) => {
                if (error) {
                    console.error('[App] 发送退出请求失败:', error);
                }
            });
        }
    };

    for (const signal of ['SIGINT', 'SIGTERM'] as const) {
        process.on(signal, () => {
            stopping = true;

            if (process.platform === 'win32') {
                requestShutdown();
            } else {
                child?.kill(signal);
            }
        });
    }

    try {
        do {
            const version = await applyPendingUpdate(root);

            if (version) {
                console.info(`[Update] 已更新至 v${version}`);
            }

            if (stopping) {
                break;
            }

            const code = await new Promise<number>((resolve, reject) => {
                child = spawn(
                    process.execPath,
                    [...process.execArgv, path.join(root, 'index.mjs'), ...process.argv.slice(2)],
                    {
                        stdio: ['inherit', 'inherit', 'inherit', 'ipc'],
                        env: { ...process.env, SNOWLUMA_UPDATE_ROOT: root },
                    },
                );
                child.once('error', reject);
                child.on('message', (message) => {
                    if (message === 'ready' && stopping) {
                        requestShutdown();
                    }
                });
                child.once('exit', (exitCode, signal) =>
                    resolve(exitCode ?? (signal === 'SIGINT' ? 130 : 143)),
                );
            });
            child = undefined;

            if (code !== RESTART_EXIT_CODE || stopping) {
                process.exitCode = code === RESTART_EXIT_CODE ? 0 : code;
                break;
            }
        } while (!stopping);
    } catch (error) {
        console.error('[Update] 启动失败:', error);
        process.exitCode = 1;
    }
}
