import { useEffect, useState } from 'react';
import { motion } from 'motion/react';
import { ArrowRight, Eye, EyeOff, KeyRound } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Input } from '@/components/ui/input';
import { ThemeToggle } from '@/components/theme-toggle';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';
import { APP_NAME, APP_VERSION } from '@/types';

interface LoginPageProps {
  onLogin: (password: string) => Promise<{ success: boolean; error?: string }>;
}

export function LoginPage({ onLogin }: LoginPageProps) {
  const { appearance } = useTheme();
  const customBg = appearance.background.type !== 'none';

  // The login page must never carry operator custom CSS. applyAppearance gates
  // it on a token, but an in-session logout / 401 expiry won't re-run it, so
  // clear any lingering custom-CSS <style> whenever the login page shows.
  useEffect(() => { document.getElementById('snowluma-custom-css')?.remove(); }, []);

  const [password, setPassword] = useState('');
  const [showPwd, setShowPwd] = useState(false);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [shake, setShake] = useState(0);

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
      {/* Sky gradient backdrop */}
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% 0%, color-mix(in oklab, var(--primary) 18%, transparent) 0%, transparent 70%)',
        }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -left-24 top-24 size-72 rounded-full bg-primary/15 blur-3xl"
        animate={{ scale: [1, 1.08, 1] }}
        transition={{ duration: 8, repeat: Infinity, ease: 'easeInOut' }}
      />
      <motion.div
        aria-hidden
        className="pointer-events-none absolute -right-16 bottom-10 size-80 rounded-full bg-primary/10 blur-3xl"
        animate={{ scale: [1, 1.12, 1] }}
        transition={{ duration: 10, repeat: Infinity, ease: 'easeInOut', delay: 0.6 }}
      />

      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-md"
      >
        <Card className="border-primary/15 shadow-xl">
          <CardContent className="p-7 sm:p-9">
            <div className="flex items-center gap-3">
              <div className="flex size-12 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                <img src="/logo.png" alt="SnowLuma" className="size-9 object-contain" />
              </div>
              <div>
                <div className="flex items-baseline gap-2">
                  <span className="text-xl font-bold tracking-tight">{APP_NAME}</span>
                  <span className="text-[11px] text-muted-foreground tabular-nums">v{APP_VERSION}</span>
                </div>
                <p className="text-xs text-muted-foreground">OneBot v11 协议网关 · 安全登录</p>
              </div>
            </div>

            <form onSubmit={handleSubmit} className="mt-7 flex flex-col gap-4">
              <motion.div
                key={shake}
                animate={shake > 0 ? { x: [0, -8, 8, -6, 6, -3, 3, 0] } : {}}
                transition={{ duration: 0.4 }}
                className="relative"
              >
                <KeyRound className="pointer-events-none absolute left-3 top-1/2 size-4 -translate-y-1/2 text-muted-foreground" />
                <Input
                  type={showPwd ? 'text' : 'password'}
                  placeholder="输入访问令牌"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  autoFocus
                  className="h-11 pl-9 pr-10 text-sm"
                />
                <button
                  type="button"
                  onClick={() => setShowPwd((v) => !v)}
                  className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:text-foreground hover:bg-accent cursor-pointer"
                  tabIndex={-1}
                  aria-label={showPwd ? '隐藏密码' : '显示密码'}
                >
                  {showPwd ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
                </button>
              </motion.div>

              {error && (
                <motion.p
                  initial={{ opacity: 0, y: -4 }}
                  animate={{ opacity: 1, y: 0 }}
                  className="rounded-md bg-destructive/10 px-3 py-2 text-center text-xs text-destructive"
                >
                  {error}
                </motion.p>
              )}

              <Button type="submit" disabled={loading || !password} className="h-11">
                {loading ? '验证中…' : (
                  <>
                    进入控制台 <ArrowRight className="size-4" />
                  </>
                )}
              </Button>
            </form>

            <p className="mt-6 text-center text-[11px] text-muted-foreground">
              © {new Date().getFullYear()} SnowLuma. All rights reserved.
            </p>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
