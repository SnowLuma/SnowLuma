import { useEffect, useMemo, useState, type ReactNode } from 'react';
import { AnimatePresence, motion } from 'motion/react';
import { Loader2 } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { InlineValidation } from '@/components/interior/inline-validation';
import {
  PasswordStrength,
  type PasswordRule as InteriorPasswordRule,
} from '@/components/interior/password-strength';
import { PasswordVisibilityIcon } from '@/components/ui/password-visibility-icon';
import { actionErrorMessage, useActionFeedback } from '@/contexts/ActionFeedbackContext';
import { useTheme } from '@/contexts/ThemeContext';
import { cn } from '@/lib/utils';

export interface PasswordRule {
  id: string;
  label: string;
  ok: boolean;
}

const EMPTY_RULES: readonly PasswordRule[] = [
  { id: 'length', label: '长度不少于 10 位', ok: false },
  { id: 'lower', label: '包含小写字母', ok: false },
  { id: 'upper', label: '包含大写字母', ok: false },
  { id: 'special', label: '包含特殊符号 (!@#$%…)', ok: false },
  { id: 'no-space', label: '不包含空格', ok: false },
];

const STRENGTH_LABELS = ['未输入', '很弱', '较弱', '一般', '良好', '强'] as const;

/** Shown under the new-password field only while the animated rule list is hidden. */
export function passwordRequirementHint(options: {
  focused: boolean;
  value: string;
  checked: boolean;
  valid: boolean;
  rules: readonly PasswordRule[];
  checkError: string;
}): string | null {
  if (options.focused || options.value.length === 0) return null;
  if (options.checkError) return `密码强度校验失败：${options.checkError}`;
  if (!options.checked || options.valid) return null;
  const unmet = options.rules.filter((rule) => !rule.ok);
  if (unmet.length === 0) return '密码尚未满足全部要求';
  return `仍需满足：${unmet.map((rule) => rule.label).join('、')}`;
}

export interface ChangePasswordFormProps {
  /** Selects whether the form changes credentials or only rehearses validation. */
  mode?: 'change' | 'rehearsal';
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
  className?: string;
  renderActions?: (state: {
    canSubmit: boolean;
    /** Fields are filled enough to try saving; strength may still be unmet. */
    canAttempt: boolean;
    submitting: boolean;
    submitLabel: string;
  }) => ReactNode;
}

export function ChangePasswordForm({
  mode = 'change',
  knownOldPassword,
  checkStrength,
  submit,
  onSuccess,
  onCancel,
  idPrefix = 'cpw',
  submitLabel = '保存新密码',
  className,
  renderActions,
}: ChangePasswordFormProps) {
  const rehearsing = mode === 'rehearsal';
  const carriesOld = rehearsing || knownOldPassword !== undefined;
  const { runAction } = useActionFeedback();
  const { appearance } = useTheme();
  const reduceMotion = appearance.reduceMotion || appearance.disableMotion;

  const [oldPassword, setOldPassword] = useState('');
  const [newPassword, setNewPassword] = useState('');
  const [confirmPassword, setConfirmPassword] = useState('');
  const [showOld, setShowOld] = useState(false);
  const [showNew, setShowNew] = useState(false);
  const [newPasswordFocused, setNewPasswordFocused] = useState(false);
  const [strengthResult, setStrengthResult] = useState<{
    password: string;
    rules: PasswordRule[];
    valid: boolean;
  }>({ password: '', rules: [], valid: false });
  const [strengthFailure, setStrengthFailure] = useState<{
    password: string;
    message: string;
  } | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState('');

  const effectiveOld = rehearsing ? '' : carriesOld ? (knownOldPassword as string) : oldPassword;
  const checkedCurrentPassword = strengthResult.password === newPassword;
  const valid = checkedCurrentPassword && strengthResult.valid;
  const strengthError = strengthFailure?.password === newPassword
    ? strengthFailure.message
    : '';
  const checkingStrength =
    newPassword.length > 0 && !checkedCurrentPassword && strengthError.length === 0;
  const displayedRules = checkedCurrentPassword && strengthResult.rules.length > 0
    ? strengthResult.rules
    : EMPTY_RULES;
  const strengthRules = useMemo<readonly InteriorPasswordRule[]>(
    () => displayedRules.map((rule) => ({
      id: rule.id,
      label: rule.label,
      test: () => rule.ok,
    })),
    [displayedRules],
  );
  const confirmMatches = newPassword.length > 0 && newPassword === confirmPassword;
  const canAttempt =
    !submitting
    && (rehearsing || effectiveOld.length > 0)
    && confirmMatches
    && (rehearsing || effectiveOld !== newPassword);
  const canSubmit = canAttempt && valid;
  const requirementHint = passwordRequirementHint({
    focused: newPasswordFocused,
    value: newPassword,
    checked: checkedCurrentPassword,
    valid,
    rules: displayedRules,
    checkError: strengthError,
  });

  // Debounce the strength check so we don't slam the API on every keystroke.
  useEffect(() => {
    if (newPassword.length === 0) {
      setStrengthFailure(null);
      return;
    }
    let cancelled = false;
    const handle = window.setTimeout(async () => {
      try {
        const res = await checkStrength(newPassword);
        if (cancelled) return;
        if (res.rules.length === 0) {
          throw new Error('服务器未返回密码强度规则');
        }
        setStrengthResult({ password: newPassword, rules: res.rules, valid: res.valid });
        setStrengthFailure(null);
      } catch (caught) {
        if (cancelled) return;
        const message = actionErrorMessage(caught);
        console.error('check password strength failed', caught);
        setStrengthFailure({ password: newPassword, message });
      }
    }, 180);
    return () => {
      cancelled = true;
      window.clearTimeout(handle);
    };
  }, [newPassword, checkStrength]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!canAttempt) return;
    if (!valid) {
      setNewPasswordFocused(true);
      document.getElementById(`${idPrefix}-new`)?.focus();
      return;
    }
    setSubmitting(true);
    setError('');
    try {
      const res = await runAction(
        {
          title: rehearsing ? '正在验证密码设置步骤' : '正在更新访问密码',
          detail: rehearsing ? '演练内容不会保存' : '正在保存新密码并使其他会话失效',
          successTitle: rehearsing ? '密码设置演练已完成' : '访问密码已更新',
          successDetail: rehearsing ? '未修改真实访问密码' : '其他会话已失效',
          errorTitle: rehearsing ? '密码设置演练失败' : '访问密码更新失败',
          resultError: (result) => result.success ? null : result.message || '修改失败',
        },
        () => submit(effectiveOld, newPassword),
      );
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
    <form onSubmit={handleSubmit} className={cn('flex flex-col gap-3', className)}>
      {!carriesOld && (
        <InlineValidation
          id={`${idPrefix}-old`}
          label="当前密码"
          type={showOld ? 'text' : 'password'}
          autoComplete="current-password"
          spellCheck={false}
          required
          value={oldPassword}
          onChange={setOldPassword}
          validate={(value) => value.length > 0 ? null : '请输入当前密码'}
          hint="用于确认当前管理员身份"
          showValidIcon={false}
          endAdornment={(
            <PasswordVisibilityButton
              visible={showOld}
              reduceMotion={reduceMotion}
              onToggle={() => setShowOld((current) => !current)}
            />
          )}
        />
      )}

      <div>
        <InlineValidation
          id={`${idPrefix}-new`}
          label="新密码"
          type={showNew ? 'text' : 'password'}
          autoComplete="new-password"
          spellCheck={false}
          required
          value={newPassword}
          onChange={setNewPassword}
          onFocus={() => setNewPasswordFocused(true)}
          onBlur={() => setNewPasswordFocused(false)}
          validationKey={`${effectiveOld}\0${newPasswordFocused}\0${valid}\0${strengthError}\0${requirementHint ?? ''}`}
          reserveLines={2}
          validate={(value) => {
            if (value.length === 0) return '请输入新密码';
            if (!rehearsing && value === effectiveOld) return '新密码不能与当前密码相同';
            return requirementHint;
          }}
          showValidIcon={false}
          endAdornment={(
            <PasswordVisibilityButton
              visible={showNew}
              reduceMotion={reduceMotion}
              onToggle={() => setShowNew((current) => !current)}
            />
          )}
        />

        <div aria-busy={checkingStrength || undefined}>
          <PasswordStrength
            value={newPassword}
            rules={strengthRules}
            labels={STRENGTH_LABELS}
            visible={newPasswordFocused}
            className="mt-1"
            status={
              checkingStrength ? (
                <span className="text-muted-foreground">正在校验密码强度…</span>
              ) : strengthError ? (
                <span role="alert" className="text-destructive">
                  密码强度校验失败：{strengthError}
                </span>
              ) : null
            }
          />
        </div>
      </div>

      <InlineValidation
        id={`${idPrefix}-confirm`}
        label="确认新密码"
        type={showNew ? 'text' : 'password'}
        autoComplete="new-password"
        spellCheck={false}
        required
        value={confirmPassword}
        onChange={setConfirmPassword}
        validationKey={newPassword}
        validate={(value) => {
          if (value.length === 0) return '请再次输入新密码';
          if (value !== newPassword) return '两次输入的密码不一致';
          return null;
        }}
        hint="需要与新密码完全一致"
        endAdornment={(
          <PasswordVisibilityButton
            visible={showNew}
            reduceMotion={reduceMotion}
            onToggle={() => setShowNew((current) => !current)}
          />
        )}
      />

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

      {renderActions ? renderActions({ canSubmit, canAttempt, submitting, submitLabel }) : (
        <div className="flex items-center gap-2 pt-1">
          {onCancel && (
            <Button type="button" variant="ghost" onClick={onCancel} className="h-10">
              取消
            </Button>
          )}
          <Button type="submit" disabled={!canAttempt} className="ml-auto h-10">
            {submitting ? (
              <>
                <Loader2 className="size-4 animate-spin" /> 提交中…
              </>
            ) : (
              submitLabel
            )}
          </Button>
        </div>
      )}
    </form>
  );
}

function PasswordVisibilityButton({
  visible,
  reduceMotion,
  onToggle,
}: {
  visible: boolean;
  reduceMotion: boolean;
  onToggle: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-label={visible ? '隐藏密码' : '显示密码'}
      className="flex size-9 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-primary sm:size-7"
    >
      <PasswordVisibilityIcon visible={visible} reduceMotion={reduceMotion} />
    </button>
  );
}
