import { Button } from '@/components/ui/button';
import { releaseAction } from '@/lib/update-versions';
import type { ReleaseVersion } from '@/types';

interface ReleaseVersionPickerProps {
    releases: ReleaseVersion[];
    current: string;
    selected: string;
    loading: boolean;
    disabled: boolean;
    hasMore: boolean;
    error: string | null;
    onSelect: (version: string) => void;
    onRefresh: () => void;
    onMore: () => void;
    onDownload: () => void;
}

export function ReleaseVersionPicker({
    releases,
    current,
    selected,
    loading,
    disabled,
    hasMore,
    error,
    onSelect,
    onRefresh,
    onMore,
    onDownload,
}: ReleaseVersionPickerProps) {
    const release = releases.find((item) => item.version === selected);
    const action = release ? releaseAction(release.version, current) : '安装';

    return (
        <div className="flex flex-col gap-3 rounded-lg border p-3">
            <label className="flex flex-col gap-2 text-sm">
                选择发行版本
                <select
                    className="w-full rounded-md border bg-background px-3 py-2 text-foreground"
                    value={selected}
                    disabled={loading || !releases.length}
                    onChange={(event) => onSelect(event.target.value)}
                >
                    <option value="">请选择版本</option>
                    {releases.map((item) => (
                        <option key={item.version} value={item.version}>
                            v{item.version} · {releaseAction(item.version, current)}
                            {item.prerelease ? ' · 预发布' : ''}
                            {!item.available ? ' · 不可安装' : ''}
                        </option>
                    ))}
                </select>
            </label>
            <div className="flex flex-wrap gap-2">
                <Button size="sm" variant="outline" disabled={loading} onClick={onRefresh}>
                    {error ? '重试加载' : '刷新列表'}
                </Button>
                {hasMore && (
                    <Button size="sm" variant="outline" disabled={loading} onClick={onMore}>
                        加载更多
                    </Button>
                )}
            </div>
            {loading && (
                <p role="status" className="text-xs text-muted-foreground">
                    正在读取发行版本…
                </p>
            )}
            {error && (
                <p role="alert" className="text-xs text-destructive">
                    {error}
                </p>
            )}
            {!loading && !error && !releases.length && (
                <p className="text-xs text-muted-foreground">暂无已发布版本。</p>
            )}
            {release && (
                <>
                    <div className="text-sm">
                        <a
                            href={release.htmlUrl}
                            target="_blank"
                            rel="noreferrer"
                            className="underline"
                        >
                            {release.name || `v${release.version}`}
                        </a>
                        {release.publishedAt && (
                            <span className="ml-2 text-xs text-muted-foreground">
                                {release.publishedAt.slice(0, 10)}
                            </span>
                        )}
                    </div>
                    {release.notes && (
                        <p className="whitespace-pre-wrap break-words text-xs text-muted-foreground">
                            {release.notes}
                        </p>
                    )}
                    {!release.available && (
                        <p role="alert" className="text-xs text-destructive">
                            {release.unavailableReason || '该版本没有适用于当前平台的完整更新包。'}
                        </p>
                    )}
                    {release.prerelease && (
                        <p className="text-xs text-muted-foreground">
                            预发布版本可能不稳定，请先备份配置和数据。
                        </p>
                    )}
                    <Button
                        size="sm"
                        className="self-start"
                        disabled={disabled || loading || !release.available}
                        onClick={onDownload}
                    >
                        {action}到 v{release.version}
                    </Button>
                </>
            )}
            <p className="text-xs text-muted-foreground">
                切换使用当前下载源。Docker
                内切换仅更新容器中的程序；重建容器后以镜像或持久化目录为准。Hook 更新可能需要重启 QQ
                或容器。
            </p>
        </div>
    );
}
