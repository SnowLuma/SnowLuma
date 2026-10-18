import { useEffect, useState } from 'react';
import { Download, Loader2, RefreshCw } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useApi } from '@/lib/api';
import type { UpdateStatus } from '@/types';

export function UpdateInstaller({ version }: { version: string | null }) {
    const api = useApi();
    const { startAction, runAction } = useActionFeedback();
    const [status, setStatus] = useState<UpdateStatus | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [confirmRestart, setConfirmRestart] = useState(false);
    const [submitting, setSubmitting] = useState(false);
    const phase = status?.phase;

    useEffect(() => {
        if (phase !== undefined && phase !== 'downloading') {
            return;
        }

        let disposed = false;
        let timer: ReturnType<typeof setTimeout>;
        const activity = phase === 'downloading' ? startAction({ title: '正在下载更新' }) : null;

        const poll = async () => {
            try {
                const next = await api.update.status();

                if (disposed && !activity) {
                    return;
                }

                if (!disposed) {
                    setStatus(next);
                    setError(null);
                }

                if (next.phase === 'ready') {
                    activity?.succeed({ title: '更新已就绪', detail: '重启后生效' });
                } else if (next.phase === 'error') {
                    activity?.fail(next.message, { title: '更新失败' });
                } else if (next.phase === 'downloading') {
                    timer = setTimeout(() => {
                        void poll();
                    }, 1000);
                }
            } catch (caught) {
                const message = caught instanceof Error ? caught.message : String(caught);
                activity?.fail(message, { title: '读取更新状态失败' });

                if (!disposed) {
                    setError(message);
                    timer = setTimeout(() => {
                        void poll();
                    }, 5000);
                }
            }
        };

        void poll();

        return () => {
            disposed = true;

            if (!activity) {
                clearTimeout(timer);
            }
        };
    }, [api, phase, startAction]);

    const download = async () => {
        if (!version) {
            return;
        }

        setSubmitting(true);
        setError(null);

        try {
            setStatus(await api.update.download(version));
        } catch (caught) {
            const message = caught instanceof Error ? caught.message : String(caught);
            setError(message);
            setStatus(null);
            startAction({ title: '下载更新' }).fail(message, { title: '下载失败' });
        } finally {
            setSubmitting(false);
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

    if (status?.phase === 'idle' && !version && !error) {
        return null;
    }

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
                        void download();
                    }}
                    disabled={submitting}
                >
                    <Download className="size-4" />
                    下载更新
                </Button>
            )}
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
