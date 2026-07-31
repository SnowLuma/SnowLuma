import { useEffect, useState } from 'react';
import {
  Activity,
  AlertTriangle,
  Clock3,
  Database,
  FileClock,
  HardDrive,
  Image,
  Loader2,
  Lock,
  MessageSquare,
  RefreshCw,
  Save,
  SmilePlus,
  Trash2,
  Users,
  type LucideIcon,
} from 'lucide-react';
import {
  Badge,
  type BadgeProps,
} from '@/components/ui/badge';
import { Button } from '@/components/ui/button';
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Progress } from '@/components/ui/progress';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { SkeletonSwap } from '@/components/interior/skeleton-swap';
import { useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useFlashMessage } from '@/hooks/use-flash-message';
import { useApi } from '@/lib/api';
import {
  buildLogSettingsPatch,
  formatBytes,
  isAllAccountsConfirmation,
  logStoragePresentation,
  type StorageTone,
} from '@/lib/storage-presentation';
import { cn } from '@/lib/utils';
import {
  ALL_ACCOUNTS_CONFIRMATION,
  type AccountStorageCategory,
  type AccountStorageSnapshot,
  type LastStorageCleanup,
  type LogStorageSettings,
  type LogStorageSettingsField,
  type StorageCleanupRequest,
  type StorageCleanupResponse,
  type StorageOverviewResponse,
} from '@/types';

const CATEGORY_INFO: Record<
  AccountStorageCategory,
  { label: string; description: string; icon: LucideIcon; bytes: keyof AccountStorageSnapshot }
> = {
  messages: {
    label: '消息历史',
    description: 'OneBot 消息与回复索引',
    icon: MessageSquare,
    bytes: 'messagesBytes',
  },
  media: {
    label: '媒体索引',
    description: '图片、语音与视频的元数据',
    icon: Image,
    bytes: 'mediaBytes',
  },
  reactions: {
    label: '表情回应',
    description: '群消息表情回应记录',
    icon: SmilePlus,
    bytes: 'reactionsBytes',
  },
};

const CATEGORIES = Object.keys(CATEGORY_INFO) as AccountStorageCategory[];

interface PendingCleanup {
  request: Exclude<StorageCleanupRequest, { scope: 'allAccounts' }>;
  title: string;
  description: string;
}

export function StoragePanel() {
  const api = useApi();
  const { runAction } = useActionFeedback();
  const [data, setData] = useState<StorageOverviewResponse | null>(null);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [saving, setSaving] = useState(false);
  const [operation, setOperation] = useState<string | null>(null);
  const [maxTotalMb, setMaxTotalMb] = useState('');
  const [retainDays, setRetainDays] = useState('');
  const [perUin, setPerUin] = useState(false);
  const [pendingCleanup, setPendingCleanup] = useState<PendingCleanup | null>(null);
  const [allAccountsCategory, setAllAccountsCategory] =
    useState<AccountStorageCategory | null>(null);
  const { msg, flash, setMsg } = useFlashMessage(5000);

  const applyOverview = (overview: StorageOverviewResponse) => {
    setData(overview);
    setMaxTotalMb(String(overview.settings.effective.logMaxTotalMb));
    setRetainDays(String(overview.settings.effective.logRetainDays));
    setPerUin(overview.settings.effective.logPerUin);
  };

  const load = async (showSpinner = false): Promise<boolean> => {
    if (showSpinner) {
      if (data === null) setLoading(true);
      else setRefreshing(true);
    }
    try {
      const overview = await api.storage.get();
      applyOverview(overview);
      return true;
    } catch (error) {
      console.error('load storage overview failed', error);
      setMsg({
        kind: 'err',
        text: error instanceof Error ? error.message : '加载存储信息失败',
      });
      return false;
    } finally {
      setLoading(false);
      setRefreshing(false);
    }
  };

  useEffect(() => {
    void load();
  }, []); // eslint-disable-line react-hooks/exhaustive-deps

  const isLocked = (field: LogStorageSettingsField): boolean =>
    data?.settings.envOverrides.includes(field) ?? false;

  const saveSettings = async () => {
    if (!data || saving || operation !== null) return;
    const nextMaxTotalMb = Number(maxTotalMb);
    const nextRetainDays = Number(retainDays);
    if (!Number.isSafeInteger(nextMaxTotalMb) || nextMaxTotalMb < 1) {
      flash('err', '日志总量上限必须是大于 0 的整数');
      return;
    }
    if (!Number.isSafeInteger(nextRetainDays) || nextRetainDays < 0) {
      flash('err', '保留天数必须是大于或等于 0 的整数');
      return;
    }

    const current: LogStorageSettings = {
      logMaxTotalMb: nextMaxTotalMb,
      logRetainDays: nextRetainDays,
      logPerUin: perUin,
    };
    const patch = buildLogSettingsPatch(
      current,
      data.settings.saved,
      data.settings.envOverrides,
    );
    if (Object.keys(patch).length === 0) {
      return;
    }

    setSaving(true);
    try {
      const result = await runAction(
        {
          title: '正在更新日志策略',
          detail: '正在保存并应用存储限制',
          successTitle: '日志策略已更新',
          successDetail: '新策略已立即生效',
          errorTitle: '日志策略更新失败',
        },
        () => api.storage.saveSettings(patch),
      );
      applyOverview({
        settings: result.settings,
        snapshot: result.snapshot,
        lastCleanup: data.lastCleanup,
      });
      flash('ok', '日志策略已保存并立即生效');
    } catch (error) {
      flash('err', error instanceof Error ? error.message : '保存失败');
      await load();
    } finally {
      setSaving(false);
    }
  };

  const runCleanup = async (request: StorageCleanupRequest): Promise<boolean> => {
    if (saving || operation !== null) return false;
    const key = cleanupKey(request);
    setOperation(key);
    try {
      const result = await runAction(
        {
          title: '正在清理存储数据',
          detail: cleanupLabel(request),
          successTitle: '存储数据清理完成',
          successDetail: cleanupResultSummary,
          errorTitle: '存储数据清理失败',
          resultError: (outcome) => outcome.success ? null : cleanupResultSummary(outcome),
        },
        () => api.storage.cleanup(request),
      );
      if (result.snapshot) {
        setData((previous) => previous
          ? {
            ...previous,
            snapshot: result.snapshot!,
            lastCleanup: result.lastCleanup ?? previous.lastCleanup,
          }
          : previous);
      } else {
        await load();
      }
      flash(result.success ? 'ok' : 'err', cleanupResultSummary(result));
      return result.success;
    } catch (error) {
      flash('err', error instanceof Error ? error.message : '清理失败');
      await load();
      return false;
    } finally {
      setOperation(null);
    }
  };

  if (loading || !data) {
    return (
      <SkeletonSwap
        ready={!loading}
        lines={7}
        lineHeight={26}
        reserve={182}
        label="存储信息"
        className={!loading ? 'skeleton-swap-fluid min-h-[182px]' : ''}
      >
        {!loading && !data ? (
          <Card>
            <CardContent className="flex flex-col items-start gap-3 pt-5">
              <p className="text-sm text-muted-foreground">存储信息暂时不可用。</p>
              <Button variant="outline" onClick={() => void load(true)}>
                <RefreshCw className="size-4" />
                重试
              </Button>
            </CardContent>
          </Card>
        ) : null}
      </SkeletonSwap>
    );
  }

  const { snapshot } = data;
  const logPresentation = logStoragePresentation(snapshot.logs);
  const onlineCount = snapshot.accounts.filter((account) => account.online).length;
  const allCategoryBytes = Object.fromEntries(
    CATEGORIES.map((category) => [
      category,
      snapshot.accounts.reduce(
        (sum, account) => sum + Number(account[CATEGORY_INFO[category].bytes]),
        0,
      ),
    ]),
  ) as Record<AccountStorageCategory, number>;

  return (
    <SkeletonSwap
      ready
      lines={7}
      lineHeight={26}
      reserve={182}
      label="存储信息"
      className="skeleton-swap-fluid min-h-[182px]"
    >
      <div className="flex flex-col gap-5">
        {msg && (
          <div
            role="status"
            className={cn(
              'rounded-lg px-3 py-2 text-xs',
              msg.kind === 'ok'
                ? 'bg-emerald-500/10 text-emerald-700 dark:text-emerald-300'
                : 'bg-red-500/10 text-red-700 dark:text-red-300',
            )}
          >
            {msg.text}
          </div>
        )}

        <Card>
          <CardHeader className="gap-3 sm:flex-row sm:items-start sm:justify-between">
            <div className="min-w-0">
              <CardTitle className="flex items-center gap-2 text-sm">
                <HardDrive className="size-4" />
              存储概览
              </CardTitle>
              <CardDescription className="mt-1">
              只统计 SnowLuma 管理的日志、账号数据库和文件传输临时数据。
              </CardDescription>
            </div>
            <Button
              variant="outline"
              size="sm"
              onClick={() => void load(true)}
              disabled={refreshing || saving || operation !== null}
              className="shrink-0"
            >
              <RefreshCw className={cn('size-4', refreshing && 'animate-spin')} />
            刷新
            </Button>
          </CardHeader>
          <CardContent className="flex flex-col gap-5">
            <div className="grid grid-cols-2 gap-2 sm:grid-cols-4">
              <Metric label="受管数据总量" value={formatBytes(snapshot.totals.managedBytes)} />
              <Metric label="日志" value={formatBytes(snapshot.totals.logsBytes)} />
              <Metric label="账号数据库" value={formatBytes(snapshot.totals.accountDataBytes)} />
              <Metric label="传输临时数据" value={formatBytes(snapshot.totals.temporaryBytes)} />
            </div>

            <div className="rounded-lg bg-muted/35 p-3">
              <div className="mb-2 flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-sm font-medium">日志容量</p>
                  <p className="mt-0.5 text-xs tabular-nums text-muted-foreground">
                    {formatBytes(snapshot.logs.totalBytes)} / {formatBytes(snapshot.logs.maxTotalBytes)}
                  </p>
                </div>
                <Badge variant={toneBadgeVariant(logPresentation.tone)}>
                  {logPresentation.label}
                </Badge>
              </div>
              <Progress
                value={logPresentation.percent}
                aria-label="日志容量使用率"
                indicatorClassName={toneProgressClass(logPresentation.tone)}
              />
              <div className="mt-2 flex flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground">
                <span>{snapshot.logs.fileCount} 个文件</span>
                <span>{snapshot.logs.activeFileCount} 个活动文件</span>
                <span>丢弃 {snapshot.logs.droppedLines} 行磁盘日志</span>
              </div>
              {snapshot.logs.lastError && (
                <div className="mt-3 flex items-start gap-2 rounded-md bg-destructive/10 px-3 py-2 text-xs text-destructive">
                  <AlertTriangle className="mt-0.5 size-3.5 shrink-0" />
                  <span className="break-words">{snapshot.logs.lastError}</span>
                </div>
              )}
            </div>

            {data.lastCleanup && <LastCleanupSummary cleanup={data.lastCleanup} />}
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <FileClock className="size-4" />
            日志策略
            </CardTitle>
            <CardDescription>
            总量上限始终生效；保留天数设为 0 时仅按总量淘汰。保存后立即应用。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-4">
            <div className="grid gap-4 sm:grid-cols-2">
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="storage-log-max" className="flex flex-wrap items-center gap-1">
                日志总量上限（MB）
                  <EnvironmentBadge locked={isLocked('logMaxTotalMb')} />
                </Label>
                <Input
                  id="storage-log-max"
                  type="number"
                  min={1}
                  step={1}
                  inputMode="numeric"
                  value={maxTotalMb}
                  onChange={(event) => setMaxTotalMb(event.target.value)}
                  disabled={isLocked('logMaxTotalMb') || saving || operation !== null}
                />
              </div>
              <div className="flex flex-col gap-1.5">
                <Label htmlFor="storage-log-days" className="flex flex-wrap items-center gap-1">
                保留天数
                  <EnvironmentBadge locked={isLocked('logRetainDays')} />
                </Label>
                <Input
                  id="storage-log-days"
                  type="number"
                  min={0}
                  step={1}
                  inputMode="numeric"
                  value={retainDays}
                  onChange={(event) => setRetainDays(event.target.value)}
                  disabled={isLocked('logRetainDays') || saving || operation !== null}
                />
              </div>
            </div>

            <div className="flex min-h-11 items-center justify-between gap-4 rounded-lg bg-muted/35 px-3 py-2">
              <div className="min-w-0">
                <p className="flex flex-wrap items-center gap-1 text-sm font-medium">
                按账号额外写入日志
                  <EnvironmentBadge locked={isLocked('logPerUin')} />
                </p>
                <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">
                开启后，同一条带账号上下文的日志还会写入账号子目录，占用会增加。
                </p>
              </div>
              <ToggleSwitch
                value={perUin}
                onChange={setPerUin}
                ariaLabel="按账号额外写入日志"
                disabled={isLocked('logPerUin') || saving || operation !== null}
              />
            </div>

            <div>
              <Button
                onClick={() => void saveSettings()}
                disabled={
                  saving
                || operation !== null
                || data.settings.envOverrides.length === 3
                }
              >
                {saving ? <Loader2 className="size-4 animate-spin" /> : <Save className="size-4" />}
              保存并应用
              </Button>
            </div>
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Trash2 className="size-4" />
            全局数据清理
            </CardTitle>
            <CardDescription>
            日志清理会轮转活动文件；临时数据清理会自动跳过正在进行的上传和下载。
            </CardDescription>
          </CardHeader>
          <CardContent className="divide-y divide-border/60 p-0">
            <CleanupRow
              icon={FileClock}
              title="日志"
              description={`${snapshot.logs.fileCount} 个文件 · ${formatBytes(snapshot.logs.totalBytes)}`}
              busy={operation === 'logs'}
              disabled={saving || operation !== null}
              onClick={() => setPendingCleanup({
                request: { scope: 'logs' },
                title: '清理全部日志？',
                description: 'SnowLuma 会先轮转活动日志，再删除旧日志，只保留新建的空文件。',
              })}
            />
            <CleanupRow
              icon={Activity}
              title="文件传输临时数据"
              description={`${snapshot.temporary.fileCount} 个文件 · ${formatBytes(snapshot.temporary.totalBytes)} · ${snapshot.temporary.activeItemCount} 个活动传输`}
              busy={operation === 'temporary'}
              disabled={saving || operation !== null}
              onClick={() => setPendingCleanup({
                request: { scope: 'temporary' },
                title: '清理非活动临时数据？',
                description: '正在上传或下载的项目会保留，其余 SnowLuma 文件传输临时数据将被删除。',
              })}
            />
          </CardContent>
        </Card>

        <Card>
          <CardHeader>
            <CardTitle className="flex items-center gap-2 text-sm">
              <Database className="size-4" />
            账号数据
            </CardTitle>
            <CardDescription>
            仅清理选中的数据库分类。账号必须离线，配置、凭据和聊天内容导出不在此页面提供。
            </CardDescription>
          </CardHeader>
          <CardContent className="flex flex-col gap-3">
            {snapshot.accounts.length === 0 ? (
              <div className="rounded-lg bg-muted/35 px-4 py-6 text-center text-sm text-muted-foreground">
              尚未发现账号数据库。
              </div>
            ) : (
              snapshot.accounts.map((account) => (
                <AccountStorageCard
                  key={account.uin}
                  account={account}
                  operation={operation}
                  saving={saving}
                  onRequest={(category) => {
                    const info = CATEGORY_INFO[category];
                    setPendingCleanup({
                      request: { scope: 'account', category, uin: account.uin },
                      title: `清理 ${account.nickname || account.uin} 的${info.label}？`,
                      description: `将删除账号 ${account.uin} 的${info.label}数据库及其边车文件，其他分类和配置不受影响。`,
                    });
                  }}
                />
              ))
            )}

            {snapshot.accounts.length > 0 && (
              <div className="rounded-lg bg-muted/35 p-3">
                <div className="mb-3 flex flex-col gap-1 sm:flex-row sm:items-center sm:justify-between">
                  <div>
                    <p className="flex items-center gap-2 text-sm font-medium">
                      <Users className="size-4" />
                    全部账号
                    </p>
                    <p className="mt-0.5 text-xs text-muted-foreground">
                      {onlineCount > 0
                        ? `${onlineCount} 个账号仍在线，全部账号清理暂不可用`
                        : '选择一个分类，并在弹窗中输入确认短语'}
                    </p>
                  </div>
                </div>
                <div className="grid gap-2 sm:grid-cols-3">
                  {CATEGORIES.map((category) => (
                    <Button
                      key={category}
                      variant="outline"
                      onClick={() => setAllAccountsCategory(category)}
                      disabled={
                        operation !== null
                      || saving
                      || onlineCount > 0
                      || allCategoryBytes[category] === 0
                      }
                      className="justify-between"
                    >
                      <span>清理全部{CATEGORY_INFO[category].label}</span>
                      <span className="text-xs tabular-nums text-muted-foreground">
                        {formatBytes(allCategoryBytes[category])}
                      </span>
                    </Button>
                  ))}
                </div>
              </div>
            )}
          </CardContent>
        </Card>

        <ConfirmDialog
          open={pendingCleanup !== null}
          onOpenChange={(open) => {
            if (!open && operation === null) setPendingCleanup(null);
          }}
          title={pendingCleanup?.title ?? ''}
          description={pendingCleanup?.description}
          confirmText="确认清理"
          destructive
          onConfirm={async () => {
            if (!pendingCleanup) return;
            await runCleanup(pendingCleanup.request);
            setPendingCleanup(null);
          }}
        />

        <AllAccountsCleanupDialog
          category={allAccountsCategory}
          busy={operation?.startsWith('allAccounts:') ?? false}
          onOpenChange={(open) => {
            if (!open && operation === null) setAllAccountsCategory(null);
          }}
          onConfirm={async (category) => {
            await runCleanup({
              scope: 'allAccounts',
              category,
              confirmation: ALL_ACCOUNTS_CONFIRMATION,
            });
            setAllAccountsCategory(null);
          }}
        />
      </div>
    </SkeletonSwap>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg bg-muted/35 p-3">
      <p className="text-xs text-muted-foreground">{label}</p>
      <p className="mt-1 text-sm font-semibold tabular-nums">{value}</p>
    </div>
  );
}

function EnvironmentBadge({ locked }: { locked: boolean }) {
  if (!locked) return null;
  return (
    <Badge variant="secondary" className="gap-1 text-micro">
      <Lock className="size-3" />
      环境变量锁定
    </Badge>
  );
}

function CleanupRow({
  icon: Icon,
  title,
  description,
  busy,
  disabled,
  onClick,
}: {
  icon: LucideIcon;
  title: string;
  description: string;
  busy: boolean;
  disabled: boolean;
  onClick: () => void;
}) {
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between">
      <div className="flex min-w-0 items-start gap-3">
        <div className="flex size-9 shrink-0 items-center justify-center rounded-md bg-muted">
          <Icon className="size-4" />
        </div>
        <div className="min-w-0">
          <p className="text-sm font-medium">{title}</p>
          <p className="mt-0.5 text-xs leading-relaxed text-muted-foreground">{description}</p>
        </div>
      </div>
      <Button
        variant="outline"
        onClick={onClick}
        disabled={disabled}
        className="w-full text-destructive hover:bg-destructive/10 hover:text-destructive sm:w-auto"
      >
        {busy ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
        清理
      </Button>
    </div>
  );
}

function AccountStorageCard({
  account,
  operation,
  saving,
  onRequest,
}: {
  account: AccountStorageSnapshot;
  operation: string | null;
  saving: boolean;
  onRequest: (category: AccountStorageCategory) => void;
}) {
  return (
    <div className="rounded-lg border border-border/60 p-3">
      <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
        <div className="min-w-0">
          <p className="truncate text-sm font-medium">{account.nickname || `账号 ${account.uin}`}</p>
          <p className="text-xs tabular-nums text-muted-foreground">{account.uin}</p>
        </div>
        <div className="flex items-center gap-2">
          <span className="text-xs tabular-nums text-muted-foreground">
            {formatBytes(account.totalBytes)}
          </span>
          <Badge variant={account.online ? 'warning' : 'secondary'}>
            {account.online ? '在线' : '离线'}
          </Badge>
        </div>
      </div>
      <div className="grid gap-2 sm:grid-cols-3">
        {CATEGORIES.map((category) => {
          const info = CATEGORY_INFO[category];
          const Icon = info.icon;
          const bytes = Number(account[info.bytes]);
          const key = `account:${account.uin}:${category}`;
          return (
            <div key={category} className="flex flex-col gap-3 rounded-md bg-muted/35 p-3">
              <div className="flex items-start gap-2">
                <Icon className="mt-0.5 size-4 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="text-xs font-medium">{info.label}</p>
                  <p className="mt-0.5 text-micro leading-relaxed text-muted-foreground">
                    {info.description}
                  </p>
                </div>
              </div>
              <div className="mt-auto flex items-center justify-between gap-2">
                <span className="text-xs tabular-nums text-muted-foreground">
                  {formatBytes(bytes)}
                </span>
                <Button
                  variant="outline"
                  size="sm"
                  onClick={() => onRequest(category)}
                  disabled={saving || operation !== null || account.online || bytes === 0}
                  aria-label={`清理 ${account.uin} 的${info.label}`}
                  className="text-destructive hover:bg-destructive/10 hover:text-destructive"
                >
                  {operation === key
                    ? <Loader2 className="size-4 animate-spin" />
                    : <Trash2 className="size-4" />}
                  清理
                </Button>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function LastCleanupSummary({ cleanup }: { cleanup: LastStorageCleanup }) {
  const label = cleanup.category
    ? CATEGORY_INFO[cleanup.category].label
    : cleanup.scope === 'logs'
      ? '日志'
      : '传输临时数据';
  return (
    <div className="flex items-start gap-2 rounded-lg bg-muted/35 px-3 py-2 text-xs text-muted-foreground">
      <Clock3 className="mt-0.5 size-3.5 shrink-0" />
      <div className="min-w-0">
        <p>
          最近清理：{label}，删除 {cleanup.deletedFiles} 个文件，释放 {formatBytes(cleanup.freedBytes)}
          {cleanup.failureCount > 0 ? `，${cleanup.failureCount} 项失败` : ''}
          {' · '}
          {formatTimestamp(cleanup.at)}
        </p>
        {cleanup.failures.length > 0 && (
          <ul className="mt-1 list-disc space-y-0.5 pl-4 text-destructive">
            {cleanup.failures.slice(0, 3).map((failure, index) => (
              <li key={`${failure.item}:${String(index)}`} className="break-words">
                {failure.item}：{failure.message}
              </li>
            ))}
            {cleanup.failures.length > 3 && (
              <li>另有 {cleanup.failures.length - 3} 项失败，请检查服务器日志</li>
            )}
          </ul>
        )}
      </div>
    </div>
  );
}

function AllAccountsCleanupDialog({
  category,
  busy,
  onOpenChange,
  onConfirm,
}: {
  category: AccountStorageCategory | null;
  busy: boolean;
  onOpenChange: (open: boolean) => void;
  onConfirm: (category: AccountStorageCategory) => Promise<void>;
}) {
  const [confirmation, setConfirmation] = useState('');
  const open = category !== null;
  const close = () => {
    setConfirmation('');
    onOpenChange(false);
  };
  return (
    <ConfirmDialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen && !busy) close();
      }}
      title={`清理全部账号的${category ? CATEGORY_INFO[category].label : '数据'}？`}
      description={
        <>
          该操作会删除所有离线账号的对应数据库及边车文件，无法撤销。请输入
          <strong className="mx-1 text-foreground">{ALL_ACCOUNTS_CONFIRMATION}</strong>
          继续。
        </>
      }
      content={(
        <div className="flex flex-col gap-1.5">
          <Label htmlFor="all-account-cleanup-confirmation">确认短语</Label>
          <Input
            id="all-account-cleanup-confirmation"
            value={confirmation}
            onChange={(event) => setConfirmation(event.target.value)}
            placeholder={ALL_ACCOUNTS_CONFIRMATION}
            autoComplete="off"
            disabled={busy}
          />
        </div>
      )}
      confirmText="确认清理"
      destructive
      confirmDisabled={!isAllAccountsConfirmation(confirmation) || busy || !category}
      onConfirm={async () => {
        if (!category || !isAllAccountsConfirmation(confirmation)) return;
        await onConfirm(category);
        setConfirmation('');
      }}
    />
  );
}

function cleanupKey(request: StorageCleanupRequest): string {
  if (request.scope === 'account') return `account:${request.uin}:${request.category}`;
  if (request.scope === 'allAccounts') return `allAccounts:${request.category}`;
  return request.scope;
}

function cleanupLabel(request: StorageCleanupRequest): string {
  if (request.scope === 'logs') return '全部日志';
  if (request.scope === 'temporary') return '非活动文件传输临时数据';
  const label = CATEGORY_INFO[request.category].label;
  return request.scope === 'allAccounts' ? `全部账号的${label}` : `账号 ${request.uin} 的${label}`;
}

function cleanupResultSummary(result: StorageCleanupResponse): string {
  const summary = [
    `删除 ${result.cleanup.deletedFiles} 个文件`,
    `释放 ${formatBytes(result.cleanup.freedBytes)}`,
  ];
  if ('skippedActiveItems' in result.cleanup && result.cleanup.skippedActiveItems > 0) {
    summary.push(`跳过 ${result.cleanup.skippedActiveItems} 个活动传输`);
  }
  if (result.cleanup.failures.length > 0) {
    summary.push(`${result.cleanup.failures.length} 项失败`);
  }
  return summary.join('，');
}

function toneBadgeVariant(tone: StorageTone): BadgeProps['variant'] {
  if (tone === 'success') return 'success';
  if (tone === 'warning') return 'warning';
  if (tone === 'danger') return 'destructive';
  return 'secondary';
}

function toneProgressClass(tone: StorageTone): string {
  if (tone === 'danger') return 'bg-destructive';
  if (tone === 'warning') return 'bg-warning';
  if (tone === 'neutral') return 'bg-muted-foreground';
  return 'bg-success';
}

function formatTimestamp(value: string): string {
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? value : date.toLocaleString();
}
