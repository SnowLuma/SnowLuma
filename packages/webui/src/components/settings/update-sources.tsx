import { useEffect, useId, useState } from 'react';
import { normalizeUpdateSourceConfig } from '@snowluma/common/update-source';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Textarea } from '@/components/ui/textarea';
import { DropdownSelect } from '@/components/ui/dropdown-select';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useApi } from '@/lib/api';
import type { UpdateSourceConfig, UpdateSourceProbe } from '@/types';

export function UpdateSources() {
    const api = useApi();
    const { runAction } = useActionFeedback();
    const id = useId();
    const [config, setConfig] = useState<UpdateSourceConfig | null>(null);
    const [mirrors, setMirrors] = useState('');
    const [results, setResults] = useState<UpdateSourceProbe[]>([]);
    const [error, setError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const [ready, setReady] = useState(false);
    const [reload, setReload] = useState(0);

    useEffect(() => {
        let disposed = false;
        setReady(false);
        void api.update
            .sources()
            .then(({ config: next }) => {
                if (!disposed) {
                    setConfig(next);
                    setMirrors(next.mirrors.join('\n'));
                    setError(null);
                }
            })
            .catch((caught: unknown) => {
                if (!disposed) {
                    setError(caught instanceof Error ? caught.message : String(caught));
                }
            })
            .finally(() => {
                if (!disposed) {
                    setReady(true);
                }
            });

        return () => {
            disposed = true;
        };
    }, [api, reload]);

    const act = async (testing: boolean) => {
        setBusy(true);
        setError(null);

        try {
            await runAction(
                {
                    title: testing ? '正在检测更新来源' : '正在保存更新来源',
                    successTitle: testing ? '来源检测完成' : '更新来源已保存',
                    successDetail: testing
                        ? '检测从 SnowLuma 所在服务器发起'
                        : '下次检查和下载时生效',
                    errorTitle: testing ? '来源检测失败' : '保存失败',
                },
                async () => {
                    const next = normalizeUpdateSourceConfig({
                        ...config,
                        mirrors: mirrors
                            .split(/\r?\n/)
                            .map((line) => line.trim())
                            .filter(Boolean),
                    });

                    if (testing) {
                        setResults((await api.update.testSources(next)).results);
                    } else {
                        const saved = await api.update.saveSources(next);

                        if (!saved.saved || !saved.applied) {
                            throw new Error(saved.errors.join('；') || saved.message);
                        }

                        setConfig(saved.config);
                        setMirrors(saved.config.mirrors.join('\n'));
                        setResults([]);
                    }
                },
            );
        } catch (caught) {
            setError(caught instanceof Error ? caught.message : String(caught));
        } finally {
            setBusy(false);
        }
    };

    return (
        <div className="flex flex-col gap-3 px-5 py-4">
            <p className="text-sm font-medium">更新来源</p>
            {error && (
                <p role="alert" className="break-words text-xs text-destructive">
                    {error}
                </p>
            )}
            <SkeletonSwap ready={ready} reserve={100} lines={3} label="更新来源">
                {config ? (
                    <fieldset
                        disabled={busy}
                        className="flex min-w-0 flex-col gap-3 disabled:opacity-60"
                    >
                        <DropdownSelect
                            value={config.mode}
                            ariaLabel="下载来源模式"
                            options={[
                                { value: 'auto', label: '自动切换' },
                                { value: 'direct', label: 'GitHub 直连' },
                                { value: 'mirror', label: '指定镜像' },
                            ]}
                            onChange={(mode) => {
                                setConfig({ ...config, mode });
                                setResults([]);
                            }}
                        />
                        <p className="text-xs text-muted-foreground">
                            自动模式先尝试
                            GitHub，失败后按列表顺序切换。镜像用于文件下载，版本查询也会尝试 GitHub
                            发布页面。
                        </p>
                        {config.mode === 'mirror' && (
                            <div className="flex flex-col gap-1.5">
                                <label htmlFor={`${id}-mirror`} className="text-xs">
                                    指定镜像地址
                                </label>
                                <Input
                                    id={`${id}-mirror`}
                                    value={config.mirror}
                                    placeholder="https://ghfast.top"
                                    onChange={(event) => {
                                        setConfig({ ...config, mirror: event.target.value });
                                        setResults([]);
                                    }}
                                />
                            </div>
                        )}
                        <details>
                            <summary className="cursor-pointer text-xs">
                                编辑候选镜像（每行一个地址）
                            </summary>
                            <Textarea
                                aria-label="候选镜像地址"
                                className="mt-2 min-h-32 font-mono text-xs"
                                value={mirrors}
                                onChange={(event) => {
                                    setMirrors(event.target.value);
                                    setResults([]);
                                }}
                            />
                            <p className="mt-1 text-xs text-muted-foreground">
                                地址后会追加完整 GitHub 链接；支持带路径的代理前缀。
                            </p>
                        </details>
                        <div className="flex flex-wrap gap-2">
                            <Button
                                size="sm"
                                variant="outline"
                                onClick={() => {
                                    void act(true);
                                }}
                            >
                                检测可用性
                            </Button>
                            <Button
                                size="sm"
                                onClick={() => {
                                    void act(false);
                                }}
                            >
                                保存来源
                            </Button>
                        </div>
                        {results.length > 0 && (
                            <div className="flex flex-col gap-2">
                                <p className="text-xs text-muted-foreground">
                                    按可用性和响应延迟排序；检测结果不代表下载速度。
                                </p>
                                <ul className="flex max-h-64 flex-col gap-2 overflow-auto">
                                    {results.map((result) => (
                                        <li
                                            key={result.mirror}
                                            className="flex items-center gap-2 text-xs"
                                        >
                                            <div className="min-w-0 flex-1">
                                                <p className="break-all">
                                                    {result.mirror || 'GitHub 直连'}
                                                </p>
                                                <p
                                                    className={
                                                        result.available
                                                            ? 'text-success'
                                                            : 'text-destructive'
                                                    }
                                                >
                                                    {result.available
                                                        ? `可用 · ${result.latencyMs} ms`
                                                        : result.error || '不可用'}
                                                </p>
                                            </div>
                                            {result.available && (
                                                <Button
                                                    size="sm"
                                                    variant="outline"
                                                    onClick={() => {
                                                        setConfig({
                                                            ...config,
                                                            mode: result.mirror
                                                                ? 'mirror'
                                                                : 'direct',
                                                            mirror: result.mirror,
                                                        });
                                                    }}
                                                >
                                                    选用
                                                </Button>
                                            )}
                                        </li>
                                    ))}
                                </ul>
                                <Button
                                    size="sm"
                                    variant="outline"
                                    className="self-start"
                                    onClick={() => {
                                        setMirrors(
                                            results
                                                .filter(
                                                    (result) => result.available && result.mirror,
                                                )
                                                .map((result) => result.mirror)
                                                .join('\n'),
                                        );
                                        setConfig({ ...config, mode: 'auto' });
                                        setResults([]);
                                    }}
                                >
                                    仅保留可用镜像
                                </Button>
                                <p className="text-xs text-muted-foreground">
                                    选用或筛选后，点击「保存来源」生效。
                                </p>
                            </div>
                        )}
                    </fieldset>
                ) : (
                    ready && (
                        <Button
                            size="sm"
                            variant="outline"
                            onClick={() => setReload((value) => value + 1)}
                        >
                            重试
                        </Button>
                    )
                )}
            </SkeletonSwap>
        </div>
    );
}
