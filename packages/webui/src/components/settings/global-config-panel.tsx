import { useCallback, useEffect, useRef, useState } from 'react';
import { AlertTriangle, KeyRound, Music, Plus, RefreshCw, Trash2 } from 'lucide-react';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { DropdownSelect } from '@/components/ui/dropdown-select';
import { Label } from '@/components/ui/label';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useApi } from '@/lib/api';
import { useFlashMessage } from '@/hooks/use-flash-message';
import { cn } from '@/lib/utils';
import type { GlobalSettings } from '@/types';

const MUSIC_SIGN_DEFAULT = 'https://ss.xingzhige.com/music_card/card';

function isHttpUrl(value: string): boolean {
    try {
        const u = new URL(value);
        return (u.protocol === 'http:' || u.protocol === 'https:') && u.host.length > 0;
    } catch {
        return false;
    }
}

export function GlobalConfigPanel() {
    const api = useApi();
    const { runAction } = useActionFeedback();
    const [config, setConfig] = useState<GlobalSettings | null>(null);
    const [loading, setLoading] = useState(true);
    const { msg, flash } = useFlashMessage();
    const saveTimer = useRef<number | null>(null);
    const saveGen = useRef(0);

    const load = useCallback(async () => {
        setLoading(true);

        try {
            setConfig(await api.globalConfig.get());
        } catch (error) {
            console.error('load global config failed', error);
        } finally {
            setLoading(false);
        }
    }, [api]);

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

    // Keep partially typed URLs in the draft until the next load.
    const commit = (
        next: GlobalSettings,
        feedback: false | { title: string; successTitle: string } = {
            title: '正在更新全局配置',
            successTitle: '全局配置已更新',
        },
    ) => {
        setConfig(next);
        const gen = ++saveGen.current;

        if (saveTimer.current) {
            clearTimeout(saveTimer.current);
        }

        saveTimer.current = window.setTimeout(() => {
            saveTimer.current = null;
            const dropped =
                next.rkey.fallbackServers.some((s) => s.trim() && !isHttpUrl(s.trim())) ||
                (next.musicSignUrl.trim().length > 0 && !isHttpUrl(next.musicSignUrl.trim()));
            const save =
                feedback === false
                    ? api.globalConfig.save(next)
                    : runAction(
                          {
                              title: feedback.title,
                              successTitle: feedback.successTitle,
                              successDetail: dropped ? '已保存，无效项已忽略' : '配置已同步',
                              errorTitle: '全局配置更新失败',
                          },
                          () => api.globalConfig.save(next),
                      );
            void save
                .then(() => {
                    if (saveGen.current !== gen) {
                        return;
                    }

                    flash('ok', dropped ? '已保存（无效项已忽略）' : '已保存');
                })
                .catch((error) => {
                    if (saveGen.current !== gen) {
                        return;
                    }

                    console.error('save global config failed', error);
                    flash('err', '保存失败，请检查服务器日志');
                });
        }, 500);
    };

    if (loading || !config) {
        return (
            <SkeletonSwap
                ready={!loading}
                lines={6}
                lineHeight={26}
                reserve={156}
                label="全局配置"
                className={!loading ? 'skeleton-swap-fluid min-h-[156px]' : ''}
            >
                {!loading ? (
                    <div className="flex flex-col items-center justify-center gap-3 rounded-xl border border-dashed py-16 text-muted-foreground">
                        <AlertTriangle className="size-8 opacity-40" strokeWidth={1.5} />
                        <p className="text-sm">加载全局配置失败</p>
                        <Button variant="outline" size="sm" onClick={() => void load()}>
                            <RefreshCw className="size-3.5" /> 重试
                        </Button>
                    </div>
                ) : null}
            </SkeletonSwap>
        );
    }

    const servers = config.rkey.fallbackServers;
    const setServers = (next: string[]) =>
        commit({ ...config, rkey: { fallbackServers: next } }, false);

    return (
        <SkeletonSwap
            ready
            lines={6}
            lineHeight={26}
            reserve={156}
            label="全局配置"
            className="skeleton-swap-fluid min-h-[156px]"
        >
            <div className="flex flex-col gap-4">
                {/* rkey fallback servers */}
                <div className="flex flex-col gap-4 rounded-xl border bg-card/40 p-4">
                    <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                        <KeyRound className="mt-0.5 size-3.5 shrink-0" />
                        <p>
                            内核无法获取 <code className="font-mono">rkey</code>{' '}
                            时，依次请求下列服务器。留空关闭，建议使用自建服务。
                        </p>
                    </div>

                    <div className="flex flex-col gap-2 border-t pt-3">
                        <div className="flex items-center justify-between">
                            <Label>rkey 回退服务器</Label>
                            <Button
                                variant="outline"
                                size="sm"
                                onClick={() => setServers([...servers, ''])}
                            >
                                <Plus className="size-3.5" /> 添加
                            </Button>
                        </div>

                        {servers.length === 0 ? (
                            <p className="rounded-lg border border-dashed px-3 py-4 text-center text-xs text-muted-foreground">
                                回退服务器未启用
                            </p>
                        ) : (
                            <div className="flex flex-col gap-2">
                                {servers.map((url, i) => {
                                    const invalid = url.trim().length > 0 && !isHttpUrl(url.trim());
                                    return (
                                        <div key={i} className="flex items-center gap-2">
                                            <Input
                                                type="url"
                                                inputMode="url"
                                                spellCheck={false}
                                                placeholder="https://your-rkey-server.example/rkeys"
                                                value={url}
                                                aria-invalid={invalid}
                                                className={cn(
                                                    'font-mono text-xs',
                                                    invalid &&
                                                        'border-destructive focus-visible:ring-destructive',
                                                )}
                                                onChange={(e) =>
                                                    setServers(
                                                        servers.map((s, idx) =>
                                                            idx === i ? e.target.value : s,
                                                        ),
                                                    )
                                                }
                                            />
                                            <Button
                                                variant="ghost"
                                                size="icon-sm"
                                                aria-label="删除"
                                                className="shrink-0 text-muted-foreground hover:text-destructive"
                                                onClick={() =>
                                                    setServers(
                                                        servers.filter((_, idx) => idx !== i),
                                                    )
                                                }
                                            >
                                                <Trash2 className="size-4" />
                                            </Button>
                                        </div>
                                    );
                                })}
                                <p className="text-xs leading-relaxed text-muted-foreground">
                                    端点需返回{' '}
                                    <code className="font-mono">
                                        {'{ group_rkey, private_rkey, expired_time }'}
                                    </code>
                                    ，仅支持 HTTP(S)。
                                </p>
                            </div>
                        )}
                    </div>
                </div>

                <div className="flex flex-col gap-3 rounded-xl border bg-card/40 p-4">
                    <Label>视频上传连接数</Label>
                    <DropdownSelect
                        ariaLabel="视频上传连接数"
                        value={String(config.videoUploadConcurrency ?? 1)}
                        options={[
                            { value: '1', label: '1 路（默认）' },
                            { value: '2', label: '2 路' },
                            { value: '3', label: '3 路' },
                            { value: '4', label: '4 路' },
                        ]}
                        onChange={(value) =>
                            commit({ ...config, videoUploadConcurrency: Number(value) })
                        }
                    />
                    <p className="text-xs leading-relaxed text-muted-foreground">
                        对所有账号的下一次视频上传生效。小视频仍使用单连接；多路上传的提速效果取决于网络和服务器，遇到拥塞时会降低并发。
                    </p>
                </div>

                {/* music sign URL */}
                <div className="flex flex-col gap-4 rounded-xl border bg-card/40 p-4">
                    <div className="flex items-start gap-2 text-xs leading-relaxed text-muted-foreground">
                        <Music className="mt-0.5 size-3.5 shrink-0" />
                        <p>音乐分享卡片的签名服务，对所有账号统一生效。留空则使用内置默认服务。</p>
                    </div>
                    <div className="flex flex-col gap-1.5 border-t pt-3">
                        <Label>音乐签名服务 URL</Label>
                        <Input
                            type="url"
                            inputMode="url"
                            spellCheck={false}
                            placeholder={MUSIC_SIGN_DEFAULT}
                            value={config.musicSignUrl}
                            aria-invalid={
                                config.musicSignUrl.trim().length > 0 &&
                                !isHttpUrl(config.musicSignUrl.trim())
                            }
                            className={cn(
                                'font-mono text-xs',
                                config.musicSignUrl.trim().length > 0 &&
                                    !isHttpUrl(config.musicSignUrl.trim()) &&
                                    'border-destructive focus-visible:ring-destructive',
                            )}
                            onChange={(e) => commit({ ...config, musicSignUrl: e.target.value })}
                        />
                    </div>
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
            </div>
        </SkeletonSwap>
    );
}
