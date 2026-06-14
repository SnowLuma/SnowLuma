import { createContext, useContext, useId, useRef, useState, type ReactNode } from 'react';
import { motion } from 'motion/react';
import {
  Accessibility, Bug, Check, Clock, Code2, Download, ExternalLink, Github, Image as ImageIcon,
  Info, KeyRound, Loader2, Monitor, Moon, Palette, RefreshCw, RotateCcw, ShieldCheck,
  Sparkles, Star, Sun, Tag, Upload, Trash2,
} from 'lucide-react';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Button } from '@/components/ui/button';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { Slider } from '@/components/ui/slider';
import {
  ACCENTS,
  DEFAULT_APPEARANCE,
  FONT_MONO_OPTIONS,
  FONT_SANS_OPTIONS,
  GRADIENT_OPTIONS,
  PALETTE_OPTIONS,
  paletteResolved,
  POLL_INTERVAL_OPTIONS,
  RADIUS_OPTIONS,
  UI_SCALE,
  useTheme,
  type AccentScope,
  type BackgroundType,
  type DarkIntensity,
  type Density,
  type SidebarStyle,
  type ThemeMode,
  type TimeFormat,
} from '@/contexts/ThemeContext';
import { DEFAULT_LAYOUT, DEFAULT_PAGES, useLayout } from '@/contexts/LayoutContext';
import { NAV_ITEMS } from '@/components/layout/sidebar';
import { ChangePasswordDialog } from '@/components/change-password-dialog';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { useApi } from '@/lib/api';
import { useAppState } from '@/contexts/AppStateContext';
import { cn } from '@/lib/utils';
import { settingsRoute, type SettingsTab } from '@/router';

const TABS: { key: SettingsTab; label: string; icon: typeof Sun }[] = [
  { key: 'appearance', label: '外观', icon: Palette },
  { key: 'data', label: '数据与格式', icon: RefreshCw },
  { key: 'advanced', label: '高级', icon: Code2 },
  { key: 'account', label: '账号安全', icon: ShieldCheck },
  { key: 'about', label: '关于', icon: Info },
];

export function SettingsPage() {
  // Active tab lives in the URL (`?tab=`) so it's deep-linkable — e.g. the
  // sidebar update banner jumps straight to 关于. Default tab omits the param.
  const { tab: urlTab } = settingsRoute.useSearch();
  const navigate = settingsRoute.useNavigate();
  const tab: SettingsTab = urlTab ?? 'appearance';
  const setTab = (t: SettingsTab) =>
    void navigate({ to: '/settings', search: t === 'appearance' ? {} : { tab: t }, replace: true });
  const active = TABS.find((t) => t.key === tab);

  return (
    <div className="flex flex-col gap-5 lg:flex-row lg:items-start lg:gap-6">
      <SettingsNav tab={tab} onChange={setTab} />

      <div className="min-w-0 flex-1">
        <motion.div
          key={tab}
          initial={{ opacity: 0, y: 8 }}
          animate={{ opacity: 1, y: 0 }}
          transition={{ duration: 0.2, ease: [0.16, 1, 0.3, 1] }}
          className="flex flex-col gap-5"
        >
          <h2 className="px-0.5 text-base font-semibold tracking-tight">{active?.label}</h2>
          {tab === 'appearance' && <AppearancePanel />}
          {tab === 'data' && <DataPanel />}
          {tab === 'advanced' && <AdvancedPanel />}
          {tab === 'account' && <AccountPanel />}
          {tab === 'about' && <AboutPanel />}
        </motion.div>
      </div>
    </div>
  );
}

// ─────────────── nav: sticky rail (desktop) / scroll strip (mobile) ───────────────

function SettingsNav({ tab, onChange }: { tab: SettingsTab; onChange: (t: SettingsTab) => void }) {
  return (
    <nav
      className={cn(
        'flex flex-wrap gap-1 rounded-xl border bg-card p-1.5',
        'lg:w-52 lg:shrink-0 lg:flex-col lg:flex-nowrap lg:self-start lg:sticky lg:top-4 lg:max-h-[calc(100vh-6rem)] lg:overflow-y-auto',
      )}
    >
      {TABS.map((t) => {
        const Icon = t.icon;
        const active = tab === t.key;
        return (
          <button
            key={t.key}
            type="button"
            onClick={() => onChange(t.key)}
            aria-current={active ? 'page' : undefined}
            className={cn(
              'inline-flex shrink-0 items-center gap-2.5 whitespace-nowrap rounded-lg px-3 py-2 text-sm font-medium transition-colors cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 lg:w-full',
              active
                ? 'bg-accent text-foreground ring-1 ring-primary/20'
                : 'text-muted-foreground hover:bg-accent/50 hover:text-foreground',
            )}
          >
            <Icon className={cn('size-4 shrink-0', active && 'text-primary')} />
            {t.label}
          </button>
        );
      })}
    </nav>
  );
}

// ─────────────── shared little controls ───────────────

interface Opt<T> { value: T; label: string; icon?: typeof Sun }

// Associates a SettingRow's visible label with the control inside it (so the
// segmented radiogroup gets an accessible name without prop-threading).
const RowLabelContext = createContext<string | undefined>(undefined);

// iOS/macOS segmented control: a recessed track with a raised pill on the
// selected segment. Single-select → exposed as a radiogroup. Wraps gracefully.
function Segmented<T extends string | number>({
  value, options, onChange, disabled,
}: { value: T; options: Opt<T>[]; onChange: (v: T) => void; disabled?: boolean }) {
  const labelledBy = useContext(RowLabelContext);
  return (
    <div
      role="radiogroup"
      aria-labelledby={labelledBy}
      aria-disabled={disabled || undefined}
      className={cn('inline-flex flex-wrap items-center gap-1 rounded-lg bg-muted/60 p-1', disabled && 'opacity-50')}
    >
      {options.map((opt) => {
        const active = value === opt.value;
        const Icon = opt.icon;
        return (
          <button
            key={String(opt.value)}
            type="button"
            role="radio"
            aria-checked={active}
            disabled={disabled}
            onClick={() => onChange(opt.value)}
            className={cn(
              'inline-flex items-center gap-1.5 rounded-md px-3 py-1.5 text-sm transition-all cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40 disabled:cursor-not-allowed',
              active ? 'bg-card font-semibold text-foreground shadow-sm ring-1 ring-border' : 'font-medium text-muted-foreground hover:text-foreground',
            )}
          >
            {Icon && <Icon className="size-4" />}
            {opt.label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * A grouped-list row. `layout`:
 *  - 'auto'   — control sits right of the label on sm+, stacks under it on mobile (short controls)
 *  - 'inline' — control always pinned right (switches)
 *  - 'stack'  — control always full-width under the label (color grids, sliders, wide segments)
 */
function SettingRow({
  label, hint, children, layout = 'auto',
}: { label: string; hint?: ReactNode; children: ReactNode; layout?: 'auto' | 'inline' | 'stack' }) {
  const labelId = useId();
  const head = (
    <div className="min-w-0">
      <p id={labelId} className="text-sm font-medium">{label}</p>
      {hint && <p className="mt-0.5 text-[12px] leading-snug text-muted-foreground">{hint}</p>}
    </div>
  );
  const control = <RowLabelContext.Provider value={labelId}>{children}</RowLabelContext.Provider>;
  if (layout === 'stack') {
    return <div className="flex flex-col gap-3 px-5 py-4">{head}{control}</div>;
  }
  if (layout === 'inline') {
    return (
      <div className="flex items-center justify-between gap-4 px-5 py-4">
        {head}
        <div className="shrink-0">{control}</div>
      </div>
    );
  }
  return (
    <div className="flex flex-col gap-3 px-5 py-4 sm:flex-row sm:items-center sm:justify-between sm:gap-6">
      {head}
      <div className="sm:shrink-0">{control}</div>
    </div>
  );
}

// A settings group: a card whose header sits above a hairline-divided list of rows.
function Group({
  title, description, icon: Icon, children,
}: { title: string; description?: string; icon?: typeof Sun; children: ReactNode }) {
  return (
    <Card className="overflow-hidden">
      <CardHeader className="gap-1 pb-4">
        <CardTitle className="flex items-center gap-2 text-[15px]">
          {Icon && <Icon className="size-4 text-primary" />}
          {title}
        </CardTitle>
        {description && <CardDescription className="text-[12px] leading-relaxed">{description}</CardDescription>}
      </CardHeader>
      <div className="divide-y divide-border/60 border-t border-border/60">{children}</div>
    </Card>
  );
}

// ─────────────── 外观 ───────────────

const MODE_OPTIONS: Opt<ThemeMode>[] = [
  { value: 'light', label: '浅色', icon: Sun },
  { value: 'dark', label: '深色', icon: Moon },
  { value: 'system', label: '跟随系统', icon: Monitor },
];

const DARK_INTENSITY_OPTIONS: Opt<DarkIntensity>[] = [
  { value: 'soft', label: '柔和' },
  { value: 'black', label: '纯黑 (OLED)' },
];

const SCOPE_OPTIONS: Opt<AccentScope>[] = [
  { value: 'global', label: '全局' },
  { value: 'sidebar', label: '仅侧栏' },
];

const SIDEBAR_STYLE_OPTIONS: Opt<SidebarStyle>[] = [
  { value: 'follow', label: '跟随背景' },
  { value: 'panel', label: '浅色面板' },
  { value: 'accent', label: '强调色' },
];

const BG_TYPE_OPTIONS: Opt<BackgroundType>[] = [
  { value: 'none', label: '无' },
  { value: 'solid', label: '纯色' },
  { value: 'gradient', label: '渐变' },
  { value: 'image', label: '图片' },
];

const DENSITY_OPTIONS: Opt<Density>[] = [
  { value: 'cozy', label: '舒适' },
  { value: 'compact', label: '紧凑' },
];

function AppearancePanel() {
  const { appearance, setAppearance, uploadBackground, removeBackground } = useTheme();
  const a = appearance;
  // A Catppuccin flavor fixes its own light/dark + darkness, so the mode and
  // intensity controls are inert while one is active.
  const paletteFixed = paletteResolved(a.palette) !== null;

  return (
    <div className="flex flex-col gap-5">
      <Group title="主题" icon={Sun} description="配色方案、明暗模式与深色风格。所有改动立即生效并保存到服务器，跨设备同步。">
        <SettingRow label="配色方案" hint="“默认”跟随下方明暗模式；Catppuccin 为整套配色，会自行决定明暗。" layout="stack">
          <div className="flex flex-wrap gap-2.5" role="radiogroup" aria-label="配色方案">
            {PALETTE_OPTIONS.map((p) => {
              const active = a.palette === p.id;
              return (
                <button
                  key={p.id}
                  type="button"
                  role="radio"
                  aria-checked={active}
                  aria-label={p.label}
                  onClick={() => setAppearance({ palette: p.id })}
                  className={cn(
                    'flex w-[5.5rem] flex-col items-center gap-1.5 rounded-xl border p-1.5 transition-all cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40',
                    active ? 'border-primary ring-2 ring-primary/30' : 'border-border hover:border-foreground/30',
                  )}
                >
                  <span className="flex h-11 w-full items-center justify-center rounded-lg" style={{ backgroundColor: p.preview.bg }}>
                    <span className="flex gap-1 rounded-md px-1.5 py-1 shadow-sm" style={{ backgroundColor: p.preview.surface }}>
                      {p.preview.dots.map((d, i) => (
                        <span key={i} className="size-1.5 rounded-full" style={{ backgroundColor: d }} />
                      ))}
                    </span>
                  </span>
                  <span className="text-[11px] font-medium">{p.label}</span>
                </button>
              );
            })}
          </div>
        </SettingRow>
        <SettingRow label="显示模式" hint={paletteFixed ? '当前由 Catppuccin 配色决定明暗。' : undefined}>
          <Segmented value={a.mode} options={MODE_OPTIONS} onChange={(mode) => setAppearance({ mode })} disabled={paletteFixed} />
        </SettingRow>
        <SettingRow
          label="深色强度"
          hint={paletteFixed ? 'Catppuccin 配色自带明暗，无需调节。' : '“纯黑”将深色背景压到接近纯黑，适合 OLED 屏幕（仅深色模式下可见）。'}
          layout="stack"
        >
          <Segmented value={a.darkIntensity} options={DARK_INTENSITY_OPTIONS} onChange={(darkIntensity) => setAppearance({ darkIntensity })} disabled={paletteFixed} />
        </SettingRow>
      </Group>

      <Group title="强调色" icon={Palette} description="按钮、链接与高亮使用的主色调。">
        <SettingRow label="预设色" layout="stack">
          <div className="flex flex-wrap items-center gap-2">
            {ACCENTS.map((spec) => {
              const active = a.accentMode === 'preset' && a.accentPreset === spec.id;
              return (
                <button
                  key={spec.id}
                  type="button"
                  onClick={() => setAppearance({ accentMode: 'preset', accentPreset: spec.id })}
                  title={spec.label}
                  aria-label={spec.label}
                  className={cn(
                    'relative flex size-9 items-center justify-center rounded-full border transition-transform cursor-pointer hover:scale-105',
                    active ? 'border-foreground/30 ring-2 ring-primary' : 'border-border',
                  )}
                  style={{ backgroundColor: spec.swatch }}
                >
                  {active && <Check className="size-4 text-white drop-shadow-sm" strokeWidth={3} />}
                </button>
              );
            })}
            <label
              title="自定义颜色"
              className={cn(
                'relative flex size-9 cursor-pointer items-center justify-center overflow-hidden rounded-full border transition-transform hover:scale-105',
                a.accentMode === 'custom' ? 'border-foreground/30 ring-2 ring-primary' : 'border-border',
              )}
              style={{ background: a.accentMode === 'custom' ? a.accentCustom : 'conic-gradient(from 0deg, #f43f5e, #f59e0b, #10b981, #0ea5e9, #8b5cf6, #f43f5e)' }}
            >
              <input
                type="color"
                value={a.accentCustom}
                onChange={(e) => setAppearance({ accentMode: 'custom', accentCustom: e.target.value })}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="自定义强调色"
              />
              {a.accentMode === 'custom' && <Check className="size-4 text-white drop-shadow-sm" strokeWidth={3} />}
            </label>
          </div>
        </SettingRow>
        <SettingRow label="应用范围" hint="“仅侧栏”时，按钮等全局元素保持默认蓝，强调色只染侧栏选中项。">
          <Segmented value={a.accentScope} options={SCOPE_OPTIONS} onChange={(accentScope) => setAppearance({ accentScope })} />
        </SettingRow>
        <SettingRow label="侧栏样式">
          <Segmented value={a.sidebarStyle} options={SIDEBAR_STYLE_OPTIONS} onChange={(sidebarStyle) => setAppearance({ sidebarStyle })} />
        </SettingRow>
      </Group>

      <BackgroundCard appearance={a} setAppearance={setAppearance} uploadBackground={uploadBackground} removeBackground={removeBackground} />

      <Group title="排版与界面" icon={Palette} description="字体、圆角、缩放与密度。">
        <SettingRow label="界面字体" layout="stack">
          <Segmented value={a.fontSans} options={FONT_SANS_OPTIONS.map((f) => ({ value: f.id, label: f.label }))} onChange={(fontSans) => setAppearance({ fontSans })} />
        </SettingRow>
        <SettingRow label="等宽字体" hint="用于日志与代码。" layout="stack">
          <Segmented value={a.fontMono} options={FONT_MONO_OPTIONS.map((f) => ({ value: f.id, label: f.label }))} onChange={(fontMono) => setAppearance({ fontMono })} />
        </SettingRow>
        <SettingRow label="圆角">
          <Segmented value={a.radius} options={RADIUS_OPTIONS.map((r) => ({ value: r.value, label: r.label }))} onChange={(radius) => setAppearance({ radius })} />
        </SettingRow>
        <SettingRow label={`界面缩放（${Math.round(a.uiScale * 100)}%）`} hint="整体放大或缩小界面，适合高分屏或视力需要。" layout="stack">
          <div className="flex items-center gap-3">
            <span className="text-[11px] text-muted-foreground tabular-nums">{Math.round(UI_SCALE.min * 100)}%</span>
            <Slider
              min={UI_SCALE.min}
              max={UI_SCALE.max}
              step={UI_SCALE.step}
              value={a.uiScale}
              onChange={(e) => setAppearance({ uiScale: Number(e.target.value) })}
              className="flex-1"
              aria-label="界面缩放"
            />
            <span className="text-[11px] text-muted-foreground tabular-nums">{Math.round(UI_SCALE.max * 100)}%</span>
          </div>
        </SettingRow>
        <SettingRow label="显示密度">
          <Segmented value={a.density} options={DENSITY_OPTIONS} onChange={(density) => setAppearance({ density })} />
        </SettingRow>
      </Group>

      <Group title="无障碍与侧栏" icon={Accessibility} description="动效、对比度与侧栏默认状态。">
        <SettingRow label="减弱动效" hint="弱化页面切换、弹簧等装饰性动画（保留轻微淡入），对低端设备与晕动敏感者更友好。" layout="inline">
          <ToggleSwitch value={a.reduceMotion} onChange={(reduceMotion) => setAppearance({ reduceMotion })} ariaLabel="减弱动效" />
        </SettingRow>
        <SettingRow label="关闭全部动效" hint="比“减弱动效”更彻底：移除所有界面动画，包括入场淡入与状态点闪烁。" layout="inline">
          <ToggleSwitch value={a.disableMotion} onChange={(disableMotion) => setAppearance({ disableMotion })} ariaLabel="关闭全部动效" />
        </SettingRow>
        <SettingRow label="高对比模式" hint="加强边框与次要文字的对比度。" layout="inline">
          <ToggleSwitch value={a.highContrast} onChange={(highContrast) => setAppearance({ highContrast })} ariaLabel="高对比模式" />
        </SettingRow>
        <SettingRow label="侧栏默认折叠" hint="新会话首次进入时侧栏默认收起（手动展开/收起后以手动选择为准）。" layout="inline">
          <ToggleSwitch value={a.sidebarDefaultCollapsed} onChange={(sidebarDefaultCollapsed) => setAppearance({ sidebarDefaultCollapsed })} ariaLabel="侧栏默认折叠" />
        </SettingRow>
      </Group>
    </div>
  );
}

function BackgroundCard({
  appearance: a, setAppearance, uploadBackground, removeBackground,
}: {
  appearance: ReturnType<typeof useTheme>['appearance'];
  setAppearance: ReturnType<typeof useTheme>['setAppearance'];
  uploadBackground: ReturnType<typeof useTheme>['uploadBackground'];
  removeBackground: ReturnType<typeof useTheme>['removeBackground'];
}) {
  const fileRef = useRef<HTMLInputElement>(null);
  const [uploading, setUploading] = useState(false);
  const [busy, setBusy] = useState(false);
  const [err, setErr] = useState<string | null>(null);

  const onFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    setUploading(true);
    setErr(null);
    try {
      await uploadBackground(file);
    } catch (ex) {
      setErr(ex instanceof Error ? ex.message : '上传失败');
    } finally {
      setUploading(false);
    }
  };

  const onRemove = async () => {
    setBusy(true);
    setErr(null);
    try {
      await removeBackground();
    } catch {
      setErr('删除失败');
    } finally {
      setBusy(false);
    }
  };

  return (
    <Group title="背景" icon={ImageIcon} description="纯色、渐变或自定义壁纸，会显示在卡片之间与登录页。">
      <SettingRow label="背景类型">
        <Segmented value={a.background.type} options={BG_TYPE_OPTIONS} onChange={(type) => setAppearance({ background: { type } })} />
      </SettingRow>

      {a.background.type === 'solid' && (
        <SettingRow label="背景颜色">
          <div className="flex items-center gap-3">
            <label className="relative size-10 cursor-pointer overflow-hidden rounded-lg border" style={{ backgroundColor: a.background.color }}>
              <input
                type="color"
                value={a.background.color}
                onChange={(e) => setAppearance({ background: { color: e.target.value } })}
                className="absolute inset-0 cursor-pointer opacity-0"
                aria-label="背景颜色"
              />
            </label>
            <span className="font-mono text-sm text-muted-foreground">{a.background.color}</span>
          </div>
        </SettingRow>
      )}

      {a.background.type === 'gradient' && (
        <SettingRow label="渐变预设" layout="stack">
          <div className="flex flex-wrap gap-2">
            {GRADIENT_OPTIONS.map((g) => {
              const active = a.background.gradient === g.id;
              return (
                <button
                  key={g.id}
                  type="button"
                  onClick={() => setAppearance({ background: { gradient: g.id } })}
                  title={g.label}
                  aria-label={g.label}
                  className={cn(
                    'h-12 w-20 rounded-lg border transition-transform cursor-pointer hover:scale-105',
                    active ? 'border-foreground/30 ring-2 ring-primary' : 'border-border',
                  )}
                  style={{ backgroundImage: g.css }}
                />
              );
            })}
          </div>
        </SettingRow>
      )}

      {a.background.type === 'image' && (
        <>
          <SettingRow label="壁纸" hint="支持 PNG / JPEG / WebP，最大 5MB。" layout="stack">
            <div className="flex flex-wrap items-center gap-3">
              <input ref={fileRef} type="file" accept="image/png,image/jpeg,image/webp" onChange={onFile} className="hidden" />
              <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={uploading}>
                {uploading ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />}
                {a.background.hasImage ? '更换图片' : '上传图片'}
              </Button>
              {a.background.hasImage && (
                <Button variant="ghost" size="sm" onClick={onRemove} disabled={busy} className="text-destructive hover:text-destructive">
                  <Trash2 className="size-4" /> 移除
                </Button>
              )}
            </div>
            {a.background.hasImage && (
              <div className="overflow-hidden rounded-lg border">
                <img src={`/ui-asset/background?v=${a.background.imageVersion}`} alt="背景预览" className="h-32 w-full object-cover" />
              </div>
            )}
          </SettingRow>

          {a.background.hasImage && (
            <>
              <SettingRow label={`遮罩强度（${Math.round(a.background.imageOpacity * 100)}%）`} hint="越高越能盖住壁纸、提升前景可读性。" layout="stack">
                <Slider
                  min={0}
                  max={1}
                  step={0.05}
                  value={a.background.imageOpacity}
                  onChange={(e) => setAppearance({ background: { imageOpacity: Number(e.target.value) } })}
                  aria-label="遮罩强度"
                />
              </SettingRow>
              <SettingRow label={`模糊（${a.background.imageBlur}px）`} layout="stack">
                <Slider
                  min={0}
                  max={40}
                  step={1}
                  value={a.background.imageBlur}
                  onChange={(e) => setAppearance({ background: { imageBlur: Number(e.target.value) } })}
                  aria-label="背景模糊"
                />
              </SettingRow>
            </>
          )}
        </>
      )}

      {err && <p className="px-5 py-3 text-[12px] text-destructive">{err}</p>}
    </Group>
  );
}

// ─────────────── 数据与格式 ───────────────

const TIME_FORMAT_OPTIONS: Opt<TimeFormat>[] = [
  { value: '24h', label: '24 小时制' },
  { value: '12h', label: '12 小时制 (AM/PM)' },
];

function DataPanel() {
  const { appearance, setAppearance } = useTheme();
  const { pages, setPages } = useLayout();
  return (
    <div className="flex flex-col gap-5">
      <Group title="数据刷新" icon={RefreshCw} description="总览页轮询刷新 QQ 列表、进程列表与系统状态的间隔。">
        <SettingRow label="轮询间隔" hint={appearance.pollInterval === 0 ? '已暂停轮询' : `当前 ${appearance.pollInterval} 毫秒`} layout="stack">
          <Segmented
            value={appearance.pollInterval}
            options={POLL_INTERVAL_OPTIONS.map((o) => ({ value: o.value, label: o.label }))}
            onChange={(pollInterval) => setAppearance({ pollInterval })}
          />
        </SettingRow>
      </Group>

      <Group title="登录后落地页" description="登录后默认打开的页面。">
        <SettingRow label="默认页面" layout="stack">
          <Segmented
            value={pages.defaultRoute}
            options={NAV_ITEMS.map((n) => ({ value: n.to as string, label: n.label }))}
            onChange={(defaultRoute) => setPages({ defaultRoute })}
          />
        </SettingRow>
      </Group>

      <Group title="时间格式" icon={Clock} description="日志与告警等时间戳的显示方式。">
        <SettingRow label="时制" layout="stack">
          <Segmented value={appearance.timeFormat} options={TIME_FORMAT_OPTIONS} onChange={(timeFormat) => setAppearance({ timeFormat })} />
        </SettingRow>
      </Group>
    </div>
  );
}

// ─────────────── 高级（自定义 CSS + 备份/重置） ───────────────

function AdvancedPanel() {
  const { appearance, setAppearance } = useTheme();
  const api = useApi();
  const fileRef = useRef<HTMLInputElement>(null);
  const [msg, setMsg] = useState<{ kind: 'ok' | 'err'; text: string } | null>(null);
  const [confirmReset, setConfirmReset] = useState(false);
  const [busy, setBusy] = useState(false);

  const onExport = async () => {
    setMsg(null);
    try {
      const config = await api.ui.get();
      const blob = new Blob([JSON.stringify(config, null, 2)], { type: 'application/json' });
      const url = URL.createObjectURL(blob);
      const a = document.createElement('a');
      a.href = url;
      a.download = 'snowluma-ui-config.json';
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setMsg({ kind: 'err', text: '导出失败' });
    }
  };

  const onImportFile = async (e: React.ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (fileRef.current) fileRef.current.value = '';
    if (!file) return;
    if (file.size > 256 * 1024) {
      setMsg({ kind: 'err', text: '导入失败：文件过大（上限 256KB）' });
      return;
    }
    setMsg(null);
    setBusy(true);
    try {
      const parsed = JSON.parse(await file.text()) as unknown;
      if (typeof parsed !== 'object' || parsed === null) throw new Error('shape');
      await api.ui.save(parsed as Parameters<typeof api.ui.save>[0]);
      // The server normalized it; reload so appearance + layout both re-read.
      window.location.reload();
    } catch {
      setBusy(false);
      setMsg({ kind: 'err', text: '导入失败：不是有效的配置 JSON' });
    }
  };

  const doReset = async () => {
    setBusy(true);
    try {
      await api.ui.save({ appearance: DEFAULT_APPEARANCE, layout: DEFAULT_LAYOUT, pages: DEFAULT_PAGES });
      window.location.reload();
    } catch {
      setBusy(false);
      setMsg({ kind: 'err', text: '重置失败' });
    }
  };

  return (
    <div className="flex flex-col gap-5">
      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="flex items-center gap-2 text-[15px]"><Code2 className="size-4 text-primary" /> 自定义 CSS</CardTitle>
          <CardDescription className="text-[12px] leading-relaxed">
            高级用户可注入自定义样式，登录后全局生效（登录页不受影响）。
            若改坏了界面，在地址后加 <code className="rounded bg-muted px-1 py-0.5 font-mono text-[11px]">?safe-mode=1</code> 可临时禁用自定义 CSS 进来修复。
          </CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <textarea
            value={appearance.customCss}
            onChange={(e) => setAppearance({ customCss: e.target.value })}
            maxLength={50000}
            spellCheck={false}
            placeholder={'/* 例如：放大侧栏字号 */\n.text-sidebar-foreground { font-size: 1.05em; }'}
            className="h-64 w-full resize-y rounded-lg border bg-card/40 p-3 font-mono text-[12px] leading-relaxed outline-none focus:border-primary"
          />
          <div className="flex items-center justify-between gap-2">
            <span className="text-[11px] text-muted-foreground">{appearance.customCss.length} / 50000 字符</span>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setAppearance({ customCss: '' })}
              disabled={!appearance.customCss}
              className="text-destructive hover:text-destructive"
            >
              <Trash2 className="size-4" /> 清空
            </Button>
          </div>
        </CardContent>
      </Card>

      <Card>
        <CardHeader className="gap-1">
          <CardTitle className="text-[15px]">备份与重置</CardTitle>
          <CardDescription className="text-[12px] leading-relaxed">导出 / 导入全部界面配置（外观 + 布局 + 自定义 CSS）。背景图片需另行重新上传。</CardDescription>
        </CardHeader>
        <CardContent className="flex flex-col gap-3">
          <div className="flex flex-wrap items-center gap-2">
            <input ref={fileRef} type="file" accept="application/json,.json" onChange={onImportFile} className="hidden" />
            <Button variant="outline" size="sm" onClick={onExport} disabled={busy}>
              <Download className="size-4" /> 导出
            </Button>
            <Button variant="outline" size="sm" onClick={() => fileRef.current?.click()} disabled={busy}>
              {busy ? <Loader2 className="size-4 animate-spin" /> : <Upload className="size-4" />} 导入
            </Button>
            <Button variant="ghost" size="sm" onClick={() => setConfirmReset(true)} disabled={busy} className="text-destructive hover:text-destructive">
              <RotateCcw className="size-4" /> 重置全部
            </Button>
          </div>
          {msg && (
            <span className={cn('text-[11px]', msg.kind === 'ok' ? 'text-success' : 'text-destructive')}>{msg.text}</span>
          )}
        </CardContent>
      </Card>

      <ConfirmDialog
        open={confirmReset}
        onOpenChange={setConfirmReset}
        title="重置全部界面配置"
        description="将外观、仪表盘布局、导航与自定义 CSS 全部恢复为默认。此操作不可撤销。"
        confirmText="重置"
        onConfirm={doReset}
      />
    </div>
  );
}

// ─────────────── 账号安全 ───────────────

function AccountPanel() {
  const { onLogout } = useAppState();
  const [showChangePwd, setShowChangePwd] = useState(false);
  const [pwdSavedAt, setPwdSavedAt] = useState<number | null>(null);

  return (
    <Group title="账号安全" icon={ShieldCheck} description="WebUI 仅有 admin 一个账号，密码以 scrypt 哈希持久化到 config/webui.json。">
      <SettingRow
        label="访问密码"
        hint={pwdSavedAt
          ? <span className="text-success">已更新（{new Date(pwdSavedAt).toLocaleTimeString()}）— 其他设备的会话已失效。</span>
          : '修改后其他设备的会话将立即失效。'}
      >
        <Button variant="outline" size="sm" onClick={() => setShowChangePwd(true)}>
          <KeyRound className="size-4" /> 修改密码
        </Button>
      </SettingRow>
      <SettingRow label="退出登录" hint="立即清除当前浏览器的会话令牌。">
        <Button variant="ghost" size="sm" onClick={onLogout} className="text-destructive hover:text-destructive">
          退出登录
        </Button>
      </SettingRow>

      <ChangePasswordDialog
        open={showChangePwd}
        onOpenChange={setShowChangePwd}
        onSuccess={() => setPwdSavedAt(Date.now())}
      />
    </Group>
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

// Advisory software update, shown as a grouped list. Read-only: links to the
// GitHub release; SnowLuma never downloads or applies anything itself.
function UpdateGroup() {
  const { updateInfo, refreshUpdate, systemInfo } = useAppState();
  const [checking, setChecking] = useState(false);

  const onCheck = async () => {
    setChecking(true);
    try { await refreshUpdate(true); } finally { setChecking(false); }
  };

  const disabledCheck = updateInfo?.error === 'disabled';

  let status: ReactNode;
  if (!updateInfo) status = <span className="text-muted-foreground">正在检查…</span>;
  else if (disabledCheck) status = <span className="text-muted-foreground">检查已关闭</span>;
  else if (updateInfo.error) status = <span className="text-muted-foreground">无法检查</span>;
  else if (updateInfo.hasUpdate && updateInfo.latest) status = <span className="font-medium text-primary">发现新版本</span>;
  else status = <span className="inline-flex items-center gap-1.5 text-success"><Check className="size-3.5" /> 已是最新</span>;

  // Rich detail block, only when an update is available (narrows `latest`).
  let detail: ReactNode = null;
  if (updateInfo?.hasUpdate && updateInfo.latest) {
    const latest = updateInfo.latest;
    const hint = assetHint(latest, systemInfo?.platform, systemInfo?.arch);
    detail = (
      <div className="bg-primary/[0.05] px-5 py-4 text-left">
        <div className="flex items-center gap-2">
          <Sparkles className="size-4 text-primary" />
          <span className="text-sm font-medium">v{latest}</span>
          {updateInfo.publishedAt && (
            <span className="ml-auto text-[11px] tabular-nums text-muted-foreground">
              {new Date(updateInfo.publishedAt).toLocaleDateString()}
            </span>
          )}
        </div>
        <p className="mt-1 text-[11px] text-muted-foreground">当前 v{updateInfo.current} → 最新 v{latest}</p>
        {updateInfo.notes && (
          <pre className="mt-3 max-h-40 overflow-auto whitespace-pre-wrap rounded-lg bg-muted/50 p-3 text-[11px] leading-relaxed text-muted-foreground">
            {updateInfo.notes}
          </pre>
        )}
        {hint && (
          <p className="mt-3 text-[11px] text-muted-foreground">
            适合你的平台：<code className="rounded bg-muted px-1 py-0.5 font-mono">{hint}</code>（在下载页选择）
          </p>
        )}
        {updateInfo.htmlUrl && (
          <Button asChild size="sm" className="mt-3">
            <a href={updateInfo.htmlUrl} target="_blank" rel="noreferrer noopener">
              <Download className="size-4" /> 前往下载
            </a>
          </Button>
        )}
      </div>
    );
  }

  return (
    <Group title="软件更新" icon={Sparkles} description="仅提示新版本，从不自动下载或安装。">
      <SettingRow label="当前版本" layout="inline">
        <code className="rounded-md border bg-muted/40 px-2 py-0.5 font-mono text-xs tabular-nums">v{__APP_VERSION__}</code>
      </SettingRow>
      <SettingRow label="检查更新">
        <div className="flex items-center gap-2.5 text-[12px]">
          {status}
          {!disabledCheck && (
            <Button variant="outline" size="sm" onClick={onCheck} disabled={checking}>
              {checking ? <Loader2 className="size-4 animate-spin" /> : <RefreshCw className="size-4" />}
              重新检查
            </Button>
          )}
        </div>
      </SettingRow>
      {detail}
    </Group>
  );
}

function AboutPanel() {
  return (
    <div className="flex flex-col gap-5">
      {/* brand hero */}
      <Card className="overflow-hidden">
        <CardContent className="flex flex-col items-center gap-3 px-6 py-9 text-center">
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
        </CardContent>
      </Card>

      {/* software update */}
      <UpdateGroup />

      {/* support + links */}
      <Card className="overflow-hidden">
        <CardContent className="flex flex-col items-center gap-4 px-6 py-7 text-center">
          <Star className="size-7 fill-primary/15 text-primary" />
          <div className="flex flex-col items-center gap-1">
            <p className="text-sm font-medium">喜欢 SnowLuma？给个 Star 支持一下</p>
            <p className="max-w-xs text-[11px] leading-relaxed text-muted-foreground">
              开源不易，你的 ⭐ 是我们持续维护的最大动力。
            </p>
          </div>
          <Button asChild className="w-full max-w-xs">
            <a href={REPO_URL} target="_blank" rel="noreferrer noopener">
              <Github className="size-4" /> 去 GitHub 点 Star
            </a>
          </Button>
          <div className="flex flex-wrap items-center justify-center gap-x-5 gap-y-2 pt-1 text-[12px]">
            <AboutLink href={REPO_URL} icon={Github}>仓库</AboutLink>
            <AboutLink href={`${REPO_URL}/releases`} icon={Tag}>发行版</AboutLink>
            <AboutLink href={`${REPO_URL}/issues`} icon={Bug}>反馈问题</AboutLink>
          </div>
        </CardContent>
      </Card>
    </div>
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
