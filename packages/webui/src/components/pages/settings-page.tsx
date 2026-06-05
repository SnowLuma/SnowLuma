import { useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import { Bug, Check, Download, ExternalLink, Github, Info, KeyRound, Loader2, Monitor, Moon, Palette, RefreshCw, ShieldCheck, Sparkles, Star, Sun, Tag } from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { Separator } from '@/components/ui/separator';
import {
  ACCENTS,
  POLL_INTERVAL_OPTIONS,
  RADIUS_OPTIONS,
  useTheme,
  type AccentColor,
  type Density,
  type ThemeMode,
} from '@/contexts/ThemeContext';
import { ChangePasswordDialog } from '@/components/change-password-dialog';
import { useAppState } from '@/contexts/AppStateContext';
import { cn } from '@/lib/utils';

const MODE_OPTIONS: { value: ThemeMode; label: string; icon: typeof Sun }[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

const DENSITY_OPTIONS: { value: Density; label: string; description: string }[] = [
  { value: 'cozy', label: '舒适', description: '默认间距，阅读更轻松' },
  { value: 'compact', label: '紧凑', description: '更小的字号与行距，单屏放更多内容' },
];

type SettingsTab = 'appearance' | 'data' | 'account' | 'about';

const TABS: { key: SettingsTab; label: string; icon: typeof Sun }[] = [
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'data', label: '数据刷新', icon: RefreshCw },
  { key: 'account', label: '账号安全', icon: ShieldCheck },
  { key: 'about', label: '关于', icon: Info },
];

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('appearance');

  return (
    <div className="flex flex-col gap-5">
      <MiniTabs tab={tab} onChange={setTab} />

      {tab === 'appearance' && <AppearancePanel />}
      {tab === 'data' && <DataPanel />}
      {tab === 'account' && <AccountPanel />}
      {tab === 'about' && <AboutPanel />}
    </div>
  );
}

// ─────────────── mini tab strip ───────────────

function MiniTabs({ tab, onChange }: { tab: SettingsTab; onChange: (t: SettingsTab) => void }) {
  return (
    <div className="inline-flex w-fit items-center gap-1 rounded-lg border bg-muted/40 p-1">
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            className={cn(
              'relative inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-colors cursor-pointer',
              active ? 'text-foreground' : 'text-muted-foreground hover:text-foreground',
            )}
          >
            {active && (
              <motion.span
                layoutId="settings-tab-pill"
                className="absolute inset-0 rounded-md bg-background shadow-sm"
                transition={{ type: 'spring', stiffness: 350, damping: 30 }}
              />
            )}
            <span className="relative z-10 inline-flex items-center gap-1.5">
              <Icon className="size-4" />
              {t.label}
            </span>
          </button>
        );
      })}
    </div>
  );
}

// ─────────────── 外观 ───────────────

function AppearancePanel() {
  const { mode, setMode, accent, setAccent, radius, setRadius, density, setDensity } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>外观</CardTitle>
        <CardDescription>调整界面的明暗模式、强调色、圆角与密度。所有改动会立即应用并保存到本地。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-6">
        {/* Mode */}
        <div className="flex flex-col gap-2">
          <Label>显示模式</Label>
          <div className="flex flex-wrap gap-2">
            {MODE_OPTIONS.map((opt) => {
              const Icon = opt.icon;
              const active = mode === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setMode(opt.value)}
                  className={cn(
                    'flex items-center gap-2 rounded-lg border px-3 py-2 text-sm transition-colors cursor-pointer',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background hover:bg-accent/40',
                  )}
                >
                  <Icon className="size-4" />
                  {opt.label}
                </button>
              );
            })}
          </div>
        </div>

        <Separator />

        {/* Accent color */}
        <div className="flex flex-col gap-2">
          <Label>强调色</Label>
          <div className="flex flex-wrap gap-2">
            {ACCENTS.map((spec) => {
              const active = accent === spec.id;
              return (
                <button
                  key={spec.id}
                  type="button"
                  onClick={() => setAccent(spec.id as AccentColor)}
                  title={spec.label}
                  aria-label={spec.label}
                  className={cn(
                    'group relative flex h-9 w-9 items-center justify-center rounded-full border transition-transform cursor-pointer hover:scale-105',
                    active ? 'border-foreground/30 ring-2 ring-primary' : 'border-border',
                  )}
                  style={{ backgroundColor: spec.swatch }}
                >
                  {active && (
                    <motion.span
                      initial={{ scale: 0.4, opacity: 0 }}
                      animate={{ scale: 1, opacity: 1 }}
                      className="text-white drop-shadow-sm"
                    >
                      <Check className="size-4" strokeWidth={3} />
                    </motion.span>
                  )}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">当前：{ACCENTS.find((a) => a.id === accent)?.label}</p>
        </div>

        <Separator />

        {/* Radius */}
        <div className="flex flex-col gap-2">
          <Label>圆角</Label>
          <div className="flex flex-wrap gap-2">
            {RADIUS_OPTIONS.map((opt) => {
              const active = Math.abs(radius - opt.value) < 1e-6;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setRadius(opt.value)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm transition-colors cursor-pointer',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background hover:bg-accent/40',
                  )}
                  style={{ borderRadius: `${opt.value}rem` }}
                >
                  {opt.label}（{opt.value}rem）
                </button>
              );
            })}
          </div>
        </div>

        <Separator />

        {/* Density */}
        <div className="flex flex-col gap-2">
          <Label>显示密度</Label>
          <div className="grid gap-2 sm:grid-cols-2">
            {DENSITY_OPTIONS.map((opt) => {
              const active = density === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setDensity(opt.value)}
                  className={cn(
                    'flex flex-col items-start gap-1 rounded-lg border p-3 text-left transition-colors cursor-pointer',
                    active ? 'border-primary bg-primary/10' : 'border-border bg-background hover:bg-accent/40',
                  )}
                >
                  <span className="text-sm font-medium">{opt.label}</span>
                  <span className="text-[11px] text-muted-foreground">{opt.description}</span>
                </button>
              );
            })}
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────── 数据刷新 ───────────────

function DataPanel() {
  const { pollInterval, setPollInterval } = useTheme();
  return (
    <Card>
      <CardHeader>
        <CardTitle>数据刷新</CardTitle>
        <CardDescription>控制总览页轮询刷新 QQ 列表、进程列表与系统状态的间隔。</CardDescription>
      </CardHeader>
      <CardContent>
        <div className="flex flex-col gap-2">
          <Label>轮询间隔</Label>
          <div className="flex flex-wrap gap-2">
            {POLL_INTERVAL_OPTIONS.map((opt) => {
              const active = pollInterval === opt.value;
              return (
                <button
                  key={opt.value}
                  type="button"
                  onClick={() => setPollInterval(opt.value)}
                  className={cn(
                    'rounded-md border px-3 py-2 text-sm transition-colors cursor-pointer',
                    active
                      ? 'border-primary bg-primary/10 text-primary'
                      : 'border-border bg-background hover:bg-accent/40',
                  )}
                >
                  {opt.label}
                </button>
              );
            })}
          </div>
          <p className="text-[11px] text-muted-foreground">
            当前生效值：{pollInterval === 0 ? '已暂停轮询' : `${pollInterval} 毫秒`}
          </p>
        </div>
      </CardContent>
    </Card>
  );
}

// ─────────────── 账号安全 ───────────────

function AccountPanel() {
  const { onLogout } = useAppState();
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [pwdSavedAt, setPwdSavedAt] = useState<number | null>(null);

  return (
    <Card>
      <CardHeader>
        <CardTitle>账号安全</CardTitle>
        <CardDescription>WebUI 仅有 admin 一个账号，密码会以 scrypt 哈希形式持久化到 config/webui.json。</CardDescription>
      </CardHeader>
      <CardContent className="flex flex-col gap-3">
        <Button variant="outline" onClick={() => setShowChangePwd(true)} className="w-fit">
          <KeyRound className="size-4" />
          修改访问密码
        </Button>
        {pwdSavedAt && (
          <span className="text-[11px] text-success">
            密码已更新（{new Date(pwdSavedAt).toLocaleTimeString()}）— 其他设备的会话已失效。
          </span>
        )}

        <Separator />

        <div>
          <p className="text-sm font-medium">退出登录</p>
          <p className="mt-1 text-[11px] text-muted-foreground">立即清除当前浏览器的会话令牌。</p>
          <Button variant="ghost" onClick={onLogout} className="mt-2 text-destructive hover:text-destructive">
            退出登录
          </Button>
        </div>
      </CardContent>

      <ChangePasswordDialog
        open={showChangePwd}
        onOpenChange={setShowChangePwd}
        onSuccess={() => setPwdSavedAt(Date.now())}
      />
    </Card>
  );
}

// ─────────────── 关于 ───────────────

const REPO_URL = 'https://github.com/SnowLuma/SnowLuma';

// Best-effort guess of the release asset matching the running platform, so
// the user knows which file to grab on the GitHub release page. Returns null
// for platforms with no official asset (e.g. macOS).
function assetHint(latest: string, platform?: string, arch?: string): string | null {
  if (!platform) return null;
  const tag = `v${latest}`;
  if (platform === 'win32') return `SnowLuma-${tag}-win-x64.zip`;
  if (platform === 'linux') return `SnowLuma-${tag}-linux-${arch === 'arm64' ? 'arm64' : 'x64'}.tar.gz`;
  return null;
}

// Advisory update status. Read-only: links to the GitHub release; SnowLuma
// never downloads or applies anything itself.
function UpdateStatus() {
  const { updateInfo, refreshUpdate, systemInfo } = useAppState();
  const [checking, setChecking] = useState(false);

  const onCheck = async () => {
    setChecking(true);
    try {
      await refreshUpdate(true);
    } finally {
      setChecking(false);
    }
  };

  const checkButton = (
    <Button variant="outline" size="sm" onClick={onCheck} disabled={checking}>
      {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
      重新检查
    </Button>
  );

  if (updateInfo?.hasUpdate && updateInfo.latest) {
    const hint = assetHint(updateInfo.latest, systemInfo?.platform, systemInfo?.arch);
    return (
      <div className="w-full max-w-md rounded-xl border border-primary/30 bg-primary/[0.06] p-4 text-left">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-medium">发现新版本 v{updateInfo.latest}</span>
          {updateInfo.publishedAt && (
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
              {new Date(updateInfo.publishedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">
          当前 v{updateInfo.current} → 最新 v{updateInfo.latest}
        </p>
        {updateInfo.notes && (
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
            {updateInfo.notes}
          </pre>
        )}
        {hint && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            适合你的平台：
            <code className="rounded bg-muted px-1 py-0.5 font-mono">{hint}</code>
            （在下载页选择）
          </p>
        )}
        <div className="mt-3 flex items-center gap-2">
          {updateInfo.htmlUrl && (
            <Button asChild size="sm">
              <a href={updateInfo.htmlUrl} target="_blank" rel="noreferrer noopener">
                <Download className="size-4" />
                前往下载
              </a>
            </Button>
          )}
          {checkButton}
        </div>
      </div>
    );
  }

  let text: string;
  if (!updateInfo) text = '正在检查更新…';
  else if (updateInfo.error === 'disabled') text = '更新检查已关闭';
  else if (updateInfo.error) text = '无法检查更新';
  else text = `已是最新版本（v${updateInfo.current}）`;

  const ok = !!updateInfo && !updateInfo.error;

  return (
    <div className="flex w-full max-w-md flex-wrap items-center justify-center gap-3 text-[12px] text-muted-foreground">
      <span className="inline-flex items-center gap-1.5">
        {ok ? <Check className="size-3.5 text-success" /> : <Info className="size-3.5" />}
        {text}
      </span>
      {updateInfo?.error !== 'disabled' && checkButton}
    </div>
  );
}

function AboutPanel() {
  return (
    <Card className="overflow-hidden">
      <CardContent className="flex flex-col items-center gap-6 px-6 py-8 text-center sm:px-8">
        {/* brand hero */}
        <motion.div
          initial={{ opacity: 0, y: 10, scale: 0.96 }}
          animate={{ opacity: 1, y: 0, scale: 1 }}
          transition={{ type: 'spring', stiffness: 260, damping: 22 }}
          className="flex flex-col items-center gap-3"
        >
          <div className="relative">
            <div aria-hidden className="absolute inset-0 -z-10 scale-125 rounded-full bg-primary/20 blur-2xl" />
            <img src="/logo.png" alt="SnowLuma" className="size-20 object-contain drop-shadow-sm" />
          </div>
          <div className="flex items-center gap-2">
            <span className="text-2xl font-semibold tracking-tight">SnowLuma</span>
            <span className="rounded-full border border-primary/30 bg-primary/10 px-2 py-0.5 font-mono text-[11px] text-primary tabular-nums">
              v{__APP_VERSION__}
            </span>
          </div>
          <p className="text-sm text-muted-foreground">Next Remote Protocol Framework · 下一代远程协议框架</p>
        </motion.div>

        <p className="max-w-md text-[13px] leading-relaxed text-muted-foreground">
          以轻量注入驱动 QQ NT，对外提供标准 OneBot v11 接口，让机器人一次部署、长期稳定运行。
        </p>

        {/* Update status */}
        <UpdateStatus />

        {/* Star CTA */}
        <div className="flex w-full max-w-sm flex-col items-center gap-2 rounded-xl border bg-gradient-to-b from-primary/[0.07] to-transparent p-5">
          <Star className="size-6 fill-primary/20 text-primary" />
          <p className="text-sm font-medium">喜欢 SnowLuma？点个 Star 支持一下</p>
          <p className="text-[11px] leading-relaxed text-muted-foreground">
            开源不易，你的 ⭐ 是我们持续维护的最大动力。
          </p>
          <Button asChild className="mt-1 w-full">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
              <Github className="size-4" />
              去 GitHub 点 Star
            </a>
          </Button>
        </div>

        {/* secondary links */}
        <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 text-[12px]">
          <AboutLink href={REPO_URL} icon={Github}>仓库</AboutLink>
          <AboutLink href={`${REPO_URL}/releases`} icon={Tag}>发行版</AboutLink>
          <AboutLink href={`${REPO_URL}/issues`} icon={Bug}>反馈问题</AboutLink>
        </div>
      </CardContent>
    </Card>
  );
}

function AboutLink({ href, icon: Icon, children }: { href: string; icon: typeof Sun; children: ReactNode }) {
  return (
    <a
      href={href}
      target="_blank"
      rel="noreferrer noopener"
      className="inline-flex items-center gap-1.5 text-muted-foreground transition-colors hover:text-foreground"
    >
      <Icon className="size-3.5" />
      {children}
      <ExternalLink className="size-3 opacity-50" />
    </a>
  );
}
