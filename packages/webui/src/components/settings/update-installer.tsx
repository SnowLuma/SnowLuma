import { useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useApi } from '@/lib/api';
import { releaseAction } from '@/lib/update-versions';
import { startPolling } from '@/lib/polling';
import { createUpdateFeedback } from '@/lib/update-feedback';
import { ReleaseVersionPicker } from './release-version-picker';
import type { ReleaseVersionsResult, UpdateStatus } from '@/types';

export function UpdateInstaller({ version }: { version: string | null }) {
    const api = useApi();
    const { startAction, runAction } = useActionFeedback();
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmRestart, setConfirmRestart] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const [showVersions, setShowVersions] = useState(false);
    const [versions, setVersions] = useState<ReleaseVersionsResult | null>(null);
    const [versionsLoading, setVersionsLoading] = useState(false);
    const [versionsError, setVersionsError] = useState<string | null>(null);
    const [selectedVersion, setSelectedVersion] = useState('');
    const [downgradeVersion, setDowngradeVersion] = useState<string | null>(null);
    const phase = status?.phase;
    const canInstall = !submitting && (phase === 'idle' || phase === 'error');

    useEffect(() => {
        if (phase !== undefined && phase !== 'downloading') {
            return;
        }

        let disposed = false;
        const activity = phase === 'downloading' ? startAction({ title: '正在下载更新' }) : null;
        const feedback = createUpdateFeedback(activity, (message) => {
            (activity ?? startAction({ title: '读取更新状态' })).fail(message, {
                title: '读取更新状态失败',
            });
        });

        const stop = startPolling(
            async () => {
                try {
                    const next = await api.update.status();

                    if (disposed) {
                        return;
                    }

                    setStatus(next);
                    setError(null);

                    feedback.status(next);
                } catch (caught) {
                    if (disposed) {
                        return;
                    }

                    const message = caught instanceof Error ? caught.message : String(caught);
                    setError(message);

                    feedback.pollingError(message);
                }
            },
            phase === undefined ? 5000 : 1000,
        );

        return () => {
            disposed = true;
            stop();

            feedback.dispose();
        };
    }, [api, phase, startAction]);

    const download = async (targetVersion: string, allowDowngrade = false) => {
        setSubmitting(true);
        setError(null);

        try {
            setStatus(await api.update.download(targetVersion, { allowDowngrade }));
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            setError(message);
            // The server may have accepted the download before the response was lost.
            setStatus(null);
            startAction({ title: '下载更新' }).fail(message, { title: '下载失败' });
            throw caught;
        } finally {
            setSubmitting(false);
        }
    };

    const loadVersions = async (page = 1, force = false) => {
        setShowVersions(true);
        setVersionsLoading(true);
        setVersionsError(null);
        const activity = startAction({ title: '正在读取发行版本' });

        try {
            const result = await api.update.releases(page, force);
            setVersions((previous) => ({
                ...result,
                releases:
                    page === 1
                        ? result.releases
                        : [
                              ...(previous?.releases ?? []),
                              ...result.releases.filter(
                                  (item) =>
                                      !previous?.releases.some(
                                          (old) => old.version === item.version,
                                      ),
                              ),
                          ],
            }));

            if (page === 1) {
                setSelectedVersion('');
            }

            activity.succeed({ title: '发行版本已加载' });
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            setVersionsError(message);
            activity.fail(message, { title: '读取发行版本失败' });
        } finally {
            setVersionsLoading(false);
        }
    };

    const selectDownload = () => {
        const selected = versions?.releases.find((item) => item.version === selectedVersion);

        if (!selected?.available || !status || !canInstall) {
            return;
        }

        if (releaseAction(selected.version, status.current) === '降级') {
            setDowngradeVersion(selected.version);
        } else {
            void download(selected.version).catch(() => undefined);
        }
    };

    const restart = async () => {
        await runAction(
            {
                title: '正在重启',
                successTitle: '已请求重启',
                successDetail: '稍后刷新页面',
                errorTitle: '重启失败',
            },
            async () => {
                setStatus(await api.update.restart());
            },
        );
    };

    return (
        <div className="flex flex-col gap-3 px-5 py-4">
            {error && (
                <p role="alert" className="text-xs text-destructive">
                    {error}
                </p>
            )}
            {status?.phase === 'error' && (
                <p role="alert" className="text-xs text-destructive">
                    {status.message}
                </p>
            )}
            {status?.phase === 'unavailable' && (
                <p className="text-xs text-muted-foreground">{status.message}</p>
            )}
            {status?.phase === 'downloading' && (
                <p className="flex items-center gap-2 text-sm">
                    <Loader2 className="size-4 animate-spin" />
                    正在下载 v{status.version}
                </p>
            )}
            {status?.phase === 'restarting' && <p className="text-sm">正在重启，稍后刷新页面。</p>}
            {status?.phase === 'ready' && (
                <div className="flex items-center gap-3">
                    <span className="text-sm">v{status.version} 已就绪</span>
                    <Button size="sm" onClick={() => setConfirmRestart(true)}>
                        <RefreshCw className="size-4" />
                        重启更新
                    </Button>
                </div>
            )}
            {version && (phase === 'idle' || phase === 'error') && (
                <Button
                    size="sm"
                    className="self-start"
                    onClick={() => {
                        void download(version).catch(() => undefined);
                    }}
                    disabled={submitting}
                >
                    <Download className="size-4" />
                    下载更新
                </Button>
            )}
            <Button
                size="sm"
                variant="outline"
                className="self-start"
                disabled={versionsLoading}
                onClick={() => {
                    if (showVersions) {
                        setShowVersions(false);
                    } else if (versions) {
                        setShowVersions(true);
                    } else {
                        void loadVersions();
                    }
                }}
            >
                {showVersions ? '收起版本列表' : '选择其他版本'}
            </Button>
            {showVersions && (
                <ReleaseVersionPicker
                    releases={versions?.releases ?? []}
                    current={versions?.current ?? status?.current ?? '0.0.0'}
                    selected={selectedVersion}
                    loading={versionsLoading}
                    disabled={!canInstall}
                    hasMore={versions?.nextPage != null}
                    error={versionsError}
                    onSelect={setSelectedVersion}
                    onRefresh={() => {
                        void loadVersions(1, true);
                    }}
                    onMore={() => {
                        if (versions?.nextPage) {
                            void loadVersions(versions.nextPage);
                        }
                    }}
                    onDownload={selectDownload}
                />
            )}
            <ConfirmDialog
                open={downgradeVersion !== null}
                onOpenChange={(open) => {
                    if (!open) {
                        setDowngradeVersion(null);
                    }
                }}
                title={`确认降级到 v${downgradeVersion ?? ''}？`}
                description="请先备份配置和数据库。降级不会逆向迁移数据，旧版本可能无法读取新版本写入的配置或数据库。请确认 Node 和 QQ 版本兼容。"
                confirmText="确认降级并下载"
                destructive
                confirmDisabled={!canInstall}
                onConfirm={async () => {
                    if (downgradeVersion) {
                        await download(downgradeVersion, true);
                    }
                }}
            />
            <ConfirmDialog
                open={confirmRestart}
                onOpenChange={setConfirmRestart}
                title="重启并更新？"
                description="连接将暂时断开，配置与数据保留。"
                confirmText="重启更新"
                onConfirm={restart}
            />
        </div>
    );
}
