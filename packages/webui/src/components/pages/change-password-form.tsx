import { useEffect, useMemo, useState } from 'react';
import { motion, AnimatePresence } from 'motion/react';
import { Check, Eye, EyeOff, Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { cn } from '@/lib/utils';

export interface PasswordRule {
  id: string;
  label: string;
  ok: boolean;
}

export interface ChangePasswordFormProps {
  /**
   * When provided, the "current password" field is omitted entirely and this
   * value is used as the old password.
   *
   * Used by the forced first-time flow: the old password is *exactly* what
   * the user just logged in with, so we fill it ourselves. Rendering the
   * field at all let Edge/Chrome password-managers autofill it on upgrade —
   * users saw it pre-filled, assumed it was correct, and could never save
   * (the autofilled value was stale / not the temp password). Dropping the
   * field removes the trap entirely.
   */
  knownOldPassword?: string;
  /** Sends `{ password }`; returns the rule list + valid flag. */
  checkStrength: (password: string) => Promise<{ rules: PasswordRule[]; valid: boolean }>;
  /** Sends `{ oldPassword, newPassword }`. Returns success or error message. */
  submit: (oldPassword: string, newPassword: string) => Promise<{ success: boolean; message?: string }>;
  /** Called after a successful submit. */
  onSuccess: () => void;
  /** When provided, a cancel button is shown (used by the settings dialog). */
  onCancel?: () => void;
  /** Disambiguates input ids if two instances ever mount at once. */
  idPrefix?: string;
  submitLabel?: string;
}

export function ChangePasswordForm({
  knownOldPassword,
  checkStrength,
  submit,
  onSuccess,
  onCancel,
  idPrefix = 'cpw',
  submitLabel = '保存新密码',
}: ChangePasswordFormProps) {
  const carriesOld = knownOldPassword !== undefined;

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [rules, setRules] = useState<PasswordRule[]>([]);
  const [valid, setValid] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const effectiveOld = carriesOld ? (knownOldPassword as string) : oldPassword;
  const confirmMatches = newPassword.length > 0 && newPassword === confirmPassword;
  const canSubmit =
    !submitting && effectiveOld.length > 0 && valid && confirmMatches && effectiveOld !== newPassword;

  // Debounce the strength check so we don't slam the API on every keystroke.
  useEffect(() => {
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const res = await checkStrength(newPassword);
        if (cancelled) return;
        setRules(res.rules);
        setValid(res.valid);
      } catch {
        /* ignore – the form will just stay disabled */
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [newPassword, checkStrength]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canSubmit) return;
    setSubmitting(true);
    setError('');
    try {
      const res = await submit(effectiveOld, newPassword);
      if (res.success) {
        onSuccess();
      } else {
        setError(res.message || '修改失败');
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : '网络错误');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <form onSubmit={handleSubmit} className="flex flex-col gap-4">
      {!carriesOld && (
        <div className="flex flex-col gap-1.5">
          <Label htmlFor={`${idPrefix}-old`}>当前密码</Label>
          <div className="relative">
            <Input
              id={`${idPrefix}-old`}
              type={showOld ? 'text' : 'password'}
              autoComplete="current-password"
              value={oldPassword}
              onChange={(e) => setOldPassword(e.target.value)}
              placeholder="输入当前访问密码"
              className="h-10 pr-10 text-sm"
            />
            <button
              type="button"
              onClick={() => setShowOld((v) => !v)}
              aria-label={showOld ? '隐藏密码' : '显示密码'}
              tabIndex={-1}
              className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
            >
              {showOld ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
        </div>
      )}

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-new`}>新密码</Label>
        <div className="relative">
          <Input
            id={`${idPrefix}-new`}
            type={showNew ? 'text' : 'password'}
            autoComplete="new-password"
            value={newPassword}
            onChange={(e) => setNewPassword(e.target.value)}
            placeholder="设置新的强密码"
            className="h-10 pr-10 text-sm"
          />
          <button
            type="button"
            onClick={() => setShowNew((v) => !v)}
            aria-label={showNew ? '隐藏密码' : '显示密码'}
            tabIndex={-1}
            className="absolute right-2 top-1/2 flex size-7 -translate-y-1/2 items-center justify-center rounded-md text-muted-foreground hover:bg-accent hover:text-foreground"
          >
            {showNew ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
          </button>
        </div>
      </div>

      <div className="flex flex-col gap-1.5">
        <Label htmlFor={`${idPrefix}-confirm`}>确认新密码</Label>
        <Input
          id={`${idPrefix}-confirm`}
          type={showNew ? 'text' : 'password'}
          autoComplete="new-password"
          value={confirmPassword}
          onChange={(e) => setConfirmPassword(e.target.value)}
          placeholder="再次输入新密码"
          className="h-10 text-sm"
        />
        {confirmPassword.length > 0 && !confirmMatches && (
          <span className="text-[11px] text-destructive">两次输入的密码不一致</span>
        )}
      </div>

      <RuleList rules={rules} />

      <AnimatePresence>
        {error && (
          <motion.p
            initial={{ opacity: 0, y: -4 }}
            animate={{ opacity: 1, y: 0 }}
            exit={{ opacity: 0 }}
            className="rounded-md bg-destructive/10 px-3 py-2 text-center text-xs text-destructive"
          >
            {error}
          </motion.p>
        )}
      </AnimatePresence>

      <div className="flex items-center gap-2">
        {onCancel && (
          <Button type="button" variant="ghost" onClick={onCancel} className="h-10">
            取消
          </Button>
        )}
        <Button type="submit" disabled={!canSubmit} className="ml-auto h-10">
          {submitting ? (
            <>
              <Loader2 className="size-4 animate-spin" /> 提交中…
            </>
          ) : (
            submitLabel
          )}
        </Button>
      </div>
    </form>
  );
}

function RuleList({ rules }: { rules: PasswordRule[] }) {
  // Initial empty state: show a placeholder set so the user knows the rules
  // exist even before any input.
  const display = useMemo<PasswordRule[]>(() => {
    if (rules.length > 0) return rules;
    return [
      { id: 'length', label: '长度不少于 10 位', ok: false },
      { id: 'lower', label: '至少包含一个小写字母', ok: false },
      { id: 'upper', label: '至少包含一个大写字母', ok: false },
      { id: 'special', label: '至少包含一个特殊字符', ok: false },
      { id: 'no-space', label: '不得包含空格', ok: false },
    ];
  }, [rules]);

  return (
    <ul className="grid gap-1.5 rounded-lg border bg-muted/30 p-3">
      {display.map((rule) => (
        <li key={rule.id} className="flex items-center gap-2">
          <motion.span
            initial={false}
            animate={{
              backgroundColor: rule.ok ? 'color-mix(in oklab, var(--primary) 20%, transparent)' : 'transparent',
              borderColor: rule.ok ? 'var(--primary)' : 'var(--border)',
              scale: rule.ok ? [1, 1.18, 1] : 1,
            }}
            transition={{ duration: 0.25 }}
            className={cn('flex size-4 items-center justify-center rounded-full border')}
          >
            <AnimatePresence>
              {rule.ok && (
                <motion.span
                  key="check"
                  initial={{ opacity: 0, scale: 0.4 }}
                  animate={{ opacity: 1, scale: 1 }}
                  exit={{ opacity: 0, scale: 0.4 }}
                  transition={{ duration: 0.18 }}
                >
                  <Check className="size-3 text-primary" strokeWidth={3} />
                </motion.span>
              )}
            </AnimatePresence>
          </motion.span>
          <motion.span
            initial={false}
            animate={{ color: rule.ok ? 'var(--foreground)' : 'var(--muted-foreground)' }}
            transition={{ duration: 0.2 }}
            className="text-xs"
          >
            {rule.label}
          </motion.span>
        </li>
      ))}
    </ul>
  );
}
