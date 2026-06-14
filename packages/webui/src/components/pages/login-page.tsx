import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Eye, EyeOff, KeyRound, Sparkles } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { ToggleSwitch } from '@/components/ui/toggle-switch';
import { ThemeToggle } from '@/components/theme-toggle';
import { LoginWaves } from '@/components/login-waves';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { APP_NAME, APP_VERSION } from '@/types';

interface LoginPageProps {
  onLogin: (password: string) => Promise<{ success: boolean; error?: string }>;
}

// Device-local preference for the (heavy) animated login background. Kept out
// of the server-synced appearance on purpose: it's a "this device feels laggy"
// choice, and it must work pre-auth (where settings can't persist to the
// server). Independent of the system 减弱动效 / 关闭全部动效 settings.
const LOGIN_FX_KEY = 'snowluma_login_fx';
function readLoginFx(): boolean {
  try {
    const v = localStorage.getItem(LOGIN_FX_KEY);
    if (v === '0') return false;
    if (v === '1') return true;
  } catch { /* ignore */ }
  // No explicit choice yet → on by default, unless the OS asks for reduced
  // motion (an accessibility default; still fully overridable via the toggle).
  try { return !window.matchMedia('(prefers-reduced-motion: reduce)').matches; } catch { return true; }
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const { appearance } = useTheme();
  const customBg = appearance.background.type !== 'none';
  const reduce = appearance.reduceMotion || appearance.disableMotion;

  // The login page must never carry operator custom CSS. applyAppearance gates
  // it on a token, but an in-session logout / 401 expiry won't re-run it, so
  // clear any lingering custom-CSS <style> whenever the login page shows.
  useEffect(() => { document.getElementById('snowluma-custom-css')?.remove(); }, []);

  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(0);
  const [fxOn, setFxOn] = useState(readLoginFx);
  const [helpOpen, setHelpOpen] = useState(false);

  const toggleFx = (v: boolean) => {
    setFxOn(v);
    try { localStorage.setItem(LOGIN_FX_KEY, v ? '1' : '0'); } catch { /* ignore */ }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');
    setLoading(true);
    const result = await onLogin(password);
    setLoading(false);
    if (!result.success) {
      setError(result.error || '登录失败');
      setShake((k) => k + 1);
    }
  };

  return (
    <div className={cn('relative flex min-h-screen items-center justify-center overflow-hidden px-4 py-8', customBg ? 'bg-transparent' : 'bg-background')}>
      {/* Animated wavy-line background (device-local toggle) */}
      {fxOn && <LoginWaves />}

      {/* Soft glow backdrop — also helps the frosted card read against the waves */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(75% 55% at 50% 0%, color-mix(in oklab, var(--primary) 20%, transparent) 0%, transparent 68%)',
        }}
      />

      <div className="absolute right-4 top-4 z-20">
        <ThemeToggle />
      </div>

      <motion.div
        initial={reduce ? false : { opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={reduce ? { duration: 0 } : { duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 flex w-full max-w-md flex-col items-center"
      >
        {/* Frosted "vibrancy" card */}
        <Card className="w-full overflow-hidden border-border/50 bg-card/75 shadow-2xl shadow-primary/5 backdrop-blur-2xl supports-[backdrop-filter]:bg-card/65">
          <CardContent className="px-7 py-9 sm:px-10">
            {/* Centered brand focal point */}
            <div className="flex flex-col items-center gap-3 text-center">
              <div className="flex size-14 items-center justify-center rounded-2xl bg-primary/10 shadow-sm ring-1 ring-primary/20">
                <img src="/logo.png" alt="SnowLuma" className="size-10 object-contain" />
              </div>
              <div>
                <div className="flex items-center justify-center gap-2">
                  <span className="text-2xl font-semibold tracking-tight">{APP_NAME}</span>
                  <span className="rounded-full bg-primary/10 px-1.5 py-0.5 font-mono text-[10px] text-primary tabular-nums">v{APP_VERSION}</span>
                </div>
                <p className="mt-1 text-xs text-muted-foreground">OneBot v11 协议网关 · 安全登录</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-8 flex flex-col gap-3.5">
              <motion.div
                key={shake}
                animate={shake > 0 ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : {}}
                transition={{ duration: 0.4 }}
                className="relative"
              >
                <KeyRound className="pointer-events-none absolute left-3.5 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type={showPwd ? 'text' : 'password'}
                  placeholder="输入访问令牌"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  className="h-12 rounded-xl bg-background/40 pl-10 pr-11 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-2 top-1/2 flex size-8 -translate-y-1/2 items-center justify-center rounded-lg text-muted-foreground hover:bg-accent hover:text-foreground cursor-pointer"
                  tabIndex={-1}
                  aria-label={showPwd ? '隐藏密码' : '显示密码'}
                >
                  {showPwd ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </motion.div>

              {error && (
                <motion.p
                  initial={reduce ? false : { opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-lg bg-destructive/10 px-3 py-2 text-center text-xs text-destructive"
                >
                  {error}
                </motion.p>
              )}

              <Button type="submit" disabled={loading || !password} className="h-12 rounded-xl text-[15px]">
                {loading ? '验证中…' : (
                  <>
                    进入控制台 <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </form>

            <p className="mt-7 text-center text-[11px] text-muted-foreground">
              © {new Date().getFullYear()} SnowLuma. All rights reserved.
            </p>
          </CardContent>
        </Card>

        {/* 灵动岛-style frosted capsule: perf escape hatch for the background */}
        <motion.button
          type="button"
          onClick={() => setHelpOpen(true)}
          whileHover={reduce ? undefined : { scale: 1.04 }}
          whileTap={reduce ? undefined : { scale: 0.97 }}
          transition={{ type: 'spring', stiffness: 420, damping: 26 }}
          className="mt-5 inline-flex items-center gap-2 rounded-full border border-border/50 bg-background/45 px-4 py-2 text-[12px] font-medium text-muted-foreground shadow-lg shadow-black/5 backdrop-blur-xl transition-colors hover:text-foreground supports-[backdrop-filter]:bg-background/35 cursor-pointer outline-none focus-visible:ring-[3px] focus-visible:ring-ring/40"
        >
          <Sparkles className="size-3.5 text-primary" />
          我觉得这个界面很卡怎么办？
        </motion.button>
      </motion.div>

      <Dialog open={helpOpen} onOpenChange={setHelpOpen}>
        <DialogContent className="max-w-sm rounded-2xl">
          <DialogHeader>
            <DialogTitle>界面有点卡顿？</DialogTitle>
            <DialogDescription>
              登录页背景是一个跟随鼠标的动态线条效果，在部分设备上可能比较吃性能。可以在这里关掉它——该开关仅作用于本设备的登录页，与系统的动效设置相互独立。
            </DialogDescription>
          </DialogHeader>

          <div className="flex items-center justify-between gap-4 rounded-xl border bg-muted/30 px-4 py-3">
            <div className="min-w-0">
              <p className="text-sm font-medium">登录页动态背景</p>
              <p className="mt-0.5 text-[11px] text-muted-foreground">{fxOn ? '已开启 · 关闭后背景为静态' : '已关闭 · 背景为静态'}</p>
            </div>
            <ToggleSwitch value={fxOn} onChange={toggleFx} ariaLabel="登录页动态背景" />
          </div>

          <p className="text-[11px] leading-relaxed text-muted-foreground">
            登录后，你还可以在「系统设置 → 无障碍」里进一步「减弱动效」或「关闭全部动效」。
          </p>
        </DialogContent>
      </Dialog>
    </div>
  );
}
