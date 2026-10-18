import { useCallback, useEffect, useRef, useState } from 'react';
import { motion } from 'motion/react';
import { DEFAULT_WEBHOOK_BODY } from '@snowluma/common/notification-templates';
import { Bell, Loader2, Pencil, Plus, Send, Trash2 } from 'lucide-react';
import { Badge } from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useApi } from '@/lib/api';
import { useFlashMessage } from '@/hooks/use-flash-message';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import {
    notificationChannelType,
    type NotificationChannel,
    type NotificationsConfig,
} from '@/types';
import { NotificationChannelDialog } from './notification-channel-dialog';

/** A fresh channel with a non-colliding default id. */
function blankChannel(existing: NotificationChannel[]): NotificationChannel {
    const used = new Set(existing.map((c) => c.id));
    let n = existing.length + 1;

    while (used.has(`channel-${n}`)) {
        n += 1;
    }

    return {
        id: `channel-${n}`,
        name: '',
        type: 'webhook',
        url: '',
        bodyTemplate: DEFAULT_WEBHOOK_BODY,
        enabled: true,
    };
}

interface DialogState {
    index: number | null; // null → create
    seed: NotificationChannel;
}

export function NotificationsPanel() {
    const api = useApi();
    const { runAction } = useActionFeedback();
    const [config, setConfig] = useState<NotificationsConfig | null>(null);
    const [loading, setLoading] = useState(true);
    const [dialog, setDialog] = useState<DialogState | null>(null);
    const [testing, setTesting] = useState<string | null>(null);
    const { msg, flash, setMsg } = useFlashMessage();
    const saveTimer = useRef<number | null>(null);
    const saveGen = useRef(0);

    const load = useCallback(async () => {
        setLoading(true);
        setMsg(null);

        try {
            setConfig(await api.notifications.getConfig());
        } catch (error) {
            console.error('load notifications config failed', error);
            setMsg({ kind: 'err', text: '加载通知配置失败' });
        } finally {
            setLoading(false);
        }
    }, [api, setMsg]);

    useEffect(() => {
        void load();
    }, [load]);

    useEffect(
        () => () => {
            if (saveTimer.current) {
                clearTimeout(saveTimer.current);
            }
        },
        [],
    );

    /** Apply locally + debounced auto-save. A generation guard reconciles with
     *  the server's normalized result only if no newer edit landed meanwhile. */
    const commit = (
        next: NotificationsConfig,
        copy: { title: string; successTitle: string } = {
            title: '正在更新通知配置',
            successTitle: '通知配置已更新',
        },
    ) => {
        setConfig(next);
        const gen = ++saveGen.current;

        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
        }

        saveTimer.current = window.setTimeout(() => {
            saveTimer.current = null;
            void runAction(
                {
                    title: copy.title,
                    detail: '正在同步通知渠道设置',
                    successTitle: copy.successTitle,
                    successDetail: '通知配置已同步',
                    errorTitle: '通知配置更新失败',
                },
                () => api.notifications.saveConfig(next),
            )
                .then((result) => {
                    // Only the latest save reconciles + confirms; a superseded in-flight
                    // save stays silent (its successor will confirm).
                    if (saveGen.current !== gen) {
                        return;
                    }

                    setConfig(result);
                    flash('ok', '已保存');
                })
                .catch((error) => {
                    if (saveGen.current !== gen) {
                        return;
                    }

                    console.error('save notifications config failed', error);
                    flash('err', '保存失败，请检查服务器日志');
                });
        }, 350);
    };

    if (loading || !config) {
        return (
            <SkeletonSwap
                ready={!loading}
                lines={6}
                lineHeight={26}
                reserve={156}
                label="通知配置"
                className={!loading ? 'skeleton-swap-fluid min-h-[156px]' : ''}
            >
                {!loading && !config ? (
                    <div
                        role="alert"
                        className="flex items-center justify-between gap-3 rounded-lg border border-destructive/30 bg-destructive/10 p-4 text-sm text-destructive"
                    >
                        <span>{msg?.text ?? '加载通知配置失败'}</span>
                        <Button variant="outline" size="sm" onClick={() => void load()}>
                            重试
                        </Button>
                    </div>
                ) : null}
            </SkeletonSwap>
        );
    }

    const channels = config.channels;
    const setChannels = (
        next: NotificationChannel[],
        copy?: { title: string; successTitle: string },
    ) => commit({ ...config, channels: next }, copy);
    const otherIds = (index: number | null) =>
        channels.filter((_, i) => i !== index).map((c) => c.id);

    const openCreate = () => setDialog({ index: null, seed: blankChannel(channels) });
    const openEdit = (i: number) => setDialog({ index: i, seed: channels[i] });

    const submitChannel = (ch: NotificationChannel, index: number | null) => {
        if (index === null) {
            setChannels([...channels, ch], {
                title: '正在新增通知渠道',
                successTitle: '通知渠道已新增',
            });
        } else {
            setChannels(
                channels.map((c, idx) => (idx === index ? ch : c)),
                { title: '正在更新通知渠道', successTitle: '通知渠道已更新' },
            );
        }
    };

    const test = async (id: string) => {
        setTesting(id);

        // Persist any pending edit first — the server tests the stored channel by id.
        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
            saveTimer.current = null;
        }

        try {
            const res = await runAction(
                {
                    title: '正在测试通知渠道',
                    detail: id,
                    successTitle: '测试通知已发送',
                    successDetail: id,
                    errorTitle: '通知渠道测试失败',
                    resultError: (result) =>
                        result.success ? null : result.message || '测试发送失败',
                },
                async () => {
                    await api.notifications.saveConfig(config);
                    return api.notifications.test(id);
                },
            );
            flash(
                res.success ? 'ok' : 'err',
                res.message ?? (res.success ? '测试发送成功' : '测试发送失败'),
            );
        } catch (error) {
            console.error('test notification channel failed', error);
            flash('err', '测试请求失败');
        } finally {
            setTesting(null);
        }
    };

    return (
        <SkeletonSwap
            ready
            lines={6}
            lineHeight={26}
            reserve={156}
            label="通知配置"
            className="skeleton-swap-fluid min-h-[156px]"
        >
            <div className="flex flex-col gap-4">
                {/* Global settings */}
                <div className="flex flex-col gap-4 rounded-xl border bg-card/40 p-4">
                    <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                        <Bell className="mt-0.5 size-3.5 shrink-0" />
                        <p>在此管理通知渠道，再到账号「配置」页选择启用。</p>
                    </div>
                    <div className="flex flex-col gap-1.5 border-t pt-3">
                        <Label>去抖窗口（秒）</Label>
                        <Input
                            type="number"
                            min={0}
                            max={3600}
                            className="w-32 tabular-nums"
                            value={config.debounceSeconds}
                            onChange={(e) => {
                                const n = Math.trunc(Number(e.target.value));
                                commit({
                                    ...config,
                                    debounceSeconds: Number.isFinite(n)
                                        ? Math.min(3600, Math.max(0, n))
                                        : 0,
                                });
                            }}
                        />
                        <p className="text-xs leading-relaxed text-muted-foreground">
                            下线持续超过此时长才通知，恢复时再通知。0 表示立即通知。
                        </p>
                    </div>
                </div>

                {/* Channels */}
                <div className="flex flex-col gap-2">
                    <div className="flex items-center justify-between">
                        <h3 className="text-sm font-semibold tracking-tight">通知渠道</h3>
                        {channels.length > 0 && (
                            <Button variant="outline" size="sm" onClick={openCreate}>
                                <Plus className="size-3.5" /> 新增渠道
                            </Button>
                        )}
                    </div>

                    {channels.length === 0 ? (
                        <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-muted-foreground">
                            <Bell className="size-8 opacity-40" strokeWidth={1.5} />
                            <p className="text-sm">还没有通知渠道</p>
                            <Button variant="outline" size="sm" onClick={openCreate}>
                                <Plus className="size-3.5" /> 创建第一个
                            </Button>
                        </div>
                    ) : (
                        <div className="flex flex-col gap-2">
                            {channels.map((ch, i) => (
                                <ChannelCard
                                    key={ch.id}
                                    channel={ch}
                                    testing={testing === ch.id}
                                    onToggle={(v) =>
                                        setChannels(
                                            channels.map((c, idx) =>
                                                idx === i ? { ...c, enabled: v } : c,
                                            ),
                                            {
                                                title: '正在更新通知渠道',
                                                successTitle: '通知渠道已更新',
                                            },
                                        )
                                    }
                                    onTest={() => void test(ch.id)}
                                    onEdit={() => openEdit(i)}
                                    onDelete={() =>
                                        setChannels(
                                            channels.filter((_, idx) => idx !== i),
                                            {
                                                title: '正在删除通知渠道',
                                                successTitle: '通知渠道已删除',
                                            },
                                        )
                                    }
                                />
                            ))}
                        </div>
                    )}
                </div>

                {msg && (
                    <p
                        className={cn(
                            'text-xs',
                            msg.kind === 'ok' ? 'text-success' : 'text-destructive',
                        )}
                    >
                        {msg.text}
                    </p>
                )}

                {dialog && (
                    <NotificationChannelDialog
                        open
                        onOpenChange={(open) => !open && setDialog(null)}
                        isEdit={dialog.index != null}
                        initial={dialog.seed}
                        otherIds={otherIds(dialog.index)}
                        onSubmit={(channel) => submitChannel(channel, dialog.index)}
                    />
                )}
            </div>
        </SkeletonSwap>
    );
}

interface ChannelCardProps {
    channel: NotificationChannel;
    testing: boolean;
    onToggle: (v: boolean) => void;
    onTest: () => void;
    onEdit: () => void;
    onDelete: () => void;
}

/** Info-only row + inline actions. No live-typed fields — editing is the dialog. */
function ChannelCard({ channel, testing, onToggle, onTest, onEdit, onDelete }: ChannelCardProps) {
    const off = useTheme().appearance.disableMotion;
    return (
        <motion.div
            initial={off ? false : { opacity: 0, y: 4 }}
            animate={{ opacity: 1, y: 0 }}
            transition={off ? { duration: 0 } : { duration: 0.18 }}
            className={cn(
                'flex flex-col gap-2 rounded-xl border bg-card/40 p-3.5 transition-[background-color,opacity] duration-150 ease-out hover:bg-accent/20 sm:flex-row sm:items-center sm:gap-3',
                !channel.enabled && 'opacity-60',
            )}
        >
            <div className="min-w-0 flex-1">
                <div className="flex flex-wrap items-center gap-2">
                    <span className="font-medium">{channel.name || channel.id}</span>
                    <Badge variant="secondary" className="font-mono font-normal">
                        {channel.id}
                    </Badge>
                    <Badge variant="outline" className="font-normal">
                        {notificationChannelType(channel) === 'email' ? '邮件' : 'Webhook'}
                    </Badge>
                    {!channel.enabled && (
                        <Badge variant="secondary" className="font-normal">
                            已停用
                        </Badge>
                    )}
                </div>
                <div className="mt-0.5 truncate font-mono text-xs text-muted-foreground">
                    {notificationChannelType(channel) === 'email'
                        ? [channel.to, channel.smtpHost].filter(Boolean).join(' · ')
                        : channel.url}
                </div>
                <div className="mt-1 truncate font-mono text-meta text-muted-foreground/80">
                    {notificationChannelType(channel) === 'email'
                        ? channel.subjectTemplate || channel.bodyTemplate
                        : channel.bodyTemplate}
                </div>
            </div>

            <div className="flex items-center gap-1.5 sm:justify-end">
                <ToggleSwitch
                    value={channel.enabled}
                    onChange={onToggle}
                    ariaLabel={`启用 ${channel.name || channel.id}`}
                />
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onTest}
                    disabled={testing}
                    aria-label="测试发送"
                    className="text-muted-foreground hover:text-foreground"
                >
                    {testing ? (
                        <Loader2 className="size-4 animate-spin" />
                    ) : (
                        <Send className="optical-forward size-4" />
                    )}
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onEdit}
                    aria-label="编辑"
                    className="text-muted-foreground hover:text-foreground"
                >
                    <Pencil className="size-4" />
                </Button>
                <Button
                    variant="ghost"
                    size="icon-sm"
                    onClick={onDelete}
                    aria-label="删除"
                    className="text-muted-foreground hover:text-destructive"
                >
                    <Trash2 className="size-4" />
                </Button>
            </div>
        </motion.div>
    );
}
