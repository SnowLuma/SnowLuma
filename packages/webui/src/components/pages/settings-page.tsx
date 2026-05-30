import { useState } from 'react';
import { motion } from 'motion/react';
import { Check, KeyRound, Monitor, Moon, Palette, RefreshCw, ShieldCheck, Sun } from 'lucide-react';
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

type SettingsTab = 'appearance' | 'data' | 'account';

const TABS: { key: SettingsTab; label: string; icon: typeof Sun }[] = [
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'data', label: '数据刷新', icon: RefreshCw },
  { key: 'account', label: '账号安全', icon: ShieldCheck },
];

export function SettingsPage() {
  const [tab, setTab] = useState<SettingsTab>('appearance');

  return (
    <div className="flex flex-col gap-5">
      <MiniTabs tab={tab} onChange={setTab} />

      {tab === 'appearance' && <AppearancePanel />}
      {tab === 'data' && <DataPanel />}
      {tab === 'account' && <AccountPanel />}
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
