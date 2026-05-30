import { motion } from 'motion/react';
import { ShieldAlert } from 'lucide-react';
import { Card, CardContent } from '@/components/ui/card';
import { ThemeToggle } from '@/components/theme-toggle';
import { ChangePasswordForm, type PasswordRule } from '@/components/pages/change-password-form';

// Re-exported so existing importers (e.g. the API client) keep resolving
// `PasswordRule` from this module after the form was extracted.
export type { PasswordRule };

interface ChangePasswordPageProps {
  /**
   * The password the user just logged in with. Passed straight through to the
   * form as `knownOldPassword`, so the forced flow never renders an
   * old-password field for a browser to autofill. See change-password-form.
   */
  knownOldPassword?: string;
  title?: string;
  description?: string;
  checkStrength: (password: string) => Promise<{ rules: PasswordRule[]; valid: boolean }>;
  submit: (oldPassword: string, newPassword: string) => Promise<{ success: boolean; message?: string }>;
  onSuccess: () => void;
}

/**
 * Full-screen "you must set a new password before continuing" gate, shown
 * once right after the first login with a generated temp password. The
 * in-app "修改访问密码" action uses ChangePasswordDialog instead.
 */
export function ChangePasswordPage({
  knownOldPassword,
  title = '请先设置新的访问密码',
  description = '为了保护你的实例，必须将首次启动生成的临时密码替换为符合下列要求的强密码。',
  checkStrength,
  submit,
  onSuccess,
}: ChangePasswordPageProps) {
  return (
    <div className="relative flex min-h-screen items-center justify-center overflow-hidden bg-background px-4 py-8">
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
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>

      <motion.div
        initial={{ opacity: 0, y: 16, scale: 0.98 }}
        animate={{ opacity: 1, y: 0, scale: 1 }}
        transition={{ duration: 0.45, ease: [0.16, 1, 0.3, 1] }}
        className="relative z-10 w-full max-w-lg"
      >
        <Card className="border-primary/15 shadow-xl">
          <CardContent className="p-7 sm:p-9">
            <div className="flex items-start gap-3">
              <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
                <ShieldAlert className="size-6 text-primary" />
              </div>
              <div className="min-w-0">
                <h1 className="text-lg font-semibold tracking-tight">{title}</h1>
                <p className="mt-1 text-xs leading-relaxed text-muted-foreground">{description}</p>
              </div>
            </div>

            <div className="mt-6">
              <ChangePasswordForm
                knownOldPassword={knownOldPassword}
                checkStrength={checkStrength}
                submit={submit}
                onSuccess={onSuccess}
                idPrefix="forced-cpw"
              />
            </div>
          </CardContent>
        </Card>
      </motion.div>
    </div>
  );
}
