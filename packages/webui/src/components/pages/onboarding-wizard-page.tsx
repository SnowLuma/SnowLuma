import { useState, type ReactNode } from 'react';
import { Check, Loader2, ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { SegmentedControl } from '@/components/interior/segmented-control';
import {
  useWizardNavigation,
  WizardSteps,
  type WizardStep,
} from '@/components/interior/wizard-steps';
import { ChangePasswordForm, type PasswordRule } from '@/components/pages/change-password-form';
import {
  advanceOnboardingStep,
  buildRequiredOnboardingStepIds,
} from '@/components/pages/onboarding-steps';
import { Markdown } from '@/lib/markdown';
import { cn } from '@/lib/utils';
import type { AgreementDoc } from '@/lib/api/types';

export interface AdditionalOnboardingStep {
  id: string;
  label: string;
  content: ReactNode;
  canSkip: boolean;
  onSkip?: () => void;
  hideAdvance?: boolean;
}

interface OnboardingWizardPageProps {
  documents: AgreementDoc[];
  agreementVersion: string;
  needsConsent: boolean;
  mustChangePassword: boolean;
  knownOldPassword?: string;
  passwordMode?: 'change' | 'rehearsal';
  onAccept: () => Promise<{ success: boolean; message?: string }>;
  onConsentComplete: () => void;
  onDecline: () => void;
  checkStrength: (password: string) => Promise<{ rules: PasswordRule[]; valid: boolean }>;
  submitPassword: (
    oldPassword: string,
    newPassword: string,
  ) => Promise<{ success: boolean; message?: string }>;
  onPasswordComplete: () => void;
  onComplete: () => void;
  additionalSteps?: AdditionalOnboardingStep[];
}

const TAB_FALLBACK_TITLE: Record<string, string> = {
  eula: '用户协议 / EULA',
  privacy: '隐私政策 / Privacy',
};

export function OnboardingWizardPage({
  documents,
  agreementVersion,
  needsConsent,
  mustChangePassword,
  knownOldPassword,
  passwordMode = 'change',
  onAccept,
  onConsentComplete,
  onDecline,
  checkStrength,
  submitPassword,
  onPasswordComplete,
  onComplete,
  additionalSteps = [],
}: OnboardingWizardPageProps) {
  const [requiredStepIds] = useState(() => buildRequiredOnboardingStepIds({
    needsConsent,
    mustChangePassword,
  }));
  const [index, setIndex] = useState(0);

  const total = requiredStepIds.length + additionalSteps.length;
  const advanceFrom = (stepId: string) => {
    const order = [...requiredStepIds, ...additionalSteps.map((step) => step.id)];
    const advance = advanceOnboardingStep(order, stepId);
    if (advance.complete) {
      onComplete();
      return;
    }
    setIndex(advance.nextIndex);
  };

  const required: WizardStep[] = requiredStepIds.map((stepId) => {
    if (stepId === 'agreements') {
      return {
        id: stepId,
        label: '阅读并同意协议',
        canSkip: false,
        hideAdvance: true,
        hideBack: true,
        scrollMode: 'content',
        content: (
          <AgreementStep
            documents={documents}
            version={agreementVersion}
            onAccept={onAccept}
            onDecline={onDecline}
            onComplete={() => {
              onConsentComplete();
              advanceFrom(stepId);
            }}
          />
        ),
      };
    }
    return {
      id: stepId,
      label: '设置访问密码',
      canSkip: false,
      hideAdvance: true,
      hideBack: true,
      content: (
        <PasswordStep
          knownOldPassword={knownOldPassword}
          mode={passwordMode}
          checkStrength={checkStrength}
          submit={submitPassword}
          onComplete={() => {
            onPasswordComplete();
            advanceFrom(stepId);
          }}
        />
      ),
    };
  });

  const steps: WizardStep[] = [
    ...required,
    ...additionalSteps.map((step) => ({
      id: step.id,
      label: step.label,
      content: step.content,
      canSkip: step.canSkip,
      onSkip: step.onSkip,
      hideAdvance: step.hideAdvance,
    })),
  ];

  if (total === 0) return null;

  return (
    <div className="relative min-h-dvh overflow-x-clip bg-background antialiased">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% 0%, color-mix(in oklab, var(--primary) 18%, transparent) 0%, transparent 70%)',
        }}
      />
      <div className="absolute right-4 top-4 z-20 sm:right-6 sm:top-6">
        <ThemeToggle />
      </div>
      <main className="relative z-10 mx-auto flex h-dvh min-h-0 w-full max-w-5xl flex-col overflow-hidden px-4 pb-4 pt-14 sm:px-6 sm:pb-5 sm:pt-4">
        <header className="mx-auto mb-2 w-full max-w-2xl shrink-0 text-center">
          <p className="text-xs font-semibold tracking-wide text-primary">SnowLuma WebUI</p>
          <h1 className="mt-1 text-balance text-2xl font-semibold tracking-tight sm:text-3xl">完成首次使用设置</h1>
          <p className="mx-auto mt-1 max-w-xl text-pretty text-sm leading-relaxed text-muted-foreground">
            按顺序完成必要步骤后即可进入控制台。
          </p>
        </header>
        <WizardSteps
          steps={steps}
          index={index}
          onIndexChange={setIndex}
          onComplete={onComplete}
          label="首次使用设置步骤"
          backLabel="上一步"
          nextLabel="下一步"
          finishLabel="完成"
          skipLabel="跳过"
          spacious
          fill
        />
      </main>
    </div>
  );
}

function AgreementStep({
  documents,
  version,
  onAccept,
  onDecline,
  onComplete,
}: {
  documents: AgreementDoc[];
  version: string;
  onAccept: () => Promise<{ success: boolean; message?: string }>;
  onDecline: () => void;
  onComplete: () => void;
}) {
  const [activeId, setActiveId] = useState(documents[0]?.id ?? 'eula');
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const active = documents.find((document) => document.id === activeId) ?? documents[0];

  const accept = async () => {
    if (!agreed || submitting) return;
    setSubmitting(true);
    setError(null);
    try {
      const result = await onAccept();
      if (result.success) {
        onComplete();
        return;
      }
      setError(result.message ?? '提交失败，请重试');
    } catch (caught) {
      console.error('record onboarding consent failed', caught);
      setError(caught instanceof Error ? caught.message : '网络错误，请重试');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex items-start gap-3 sm:gap-4">
        <div className="flex size-10 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20 sm:size-12 sm:rounded-2xl">
          <ScrollText className="size-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-balance text-lg font-semibold tracking-tight sm:text-xl">请阅读并同意以下协议</h2>
          <p className="mt-0.5 max-w-2xl text-pretty text-xs leading-relaxed text-muted-foreground sm:mt-1 sm:text-sm">
            同意一次后无需重复确认；仅当协议内容更新时才会再次请求确认。
          </p>
        </div>
      </div>

      {documents.length > 1 ? (
        <div className="mt-3 max-w-full overflow-x-auto pb-1 sm:mt-4">
          <SegmentedControl
            label="协议文档"
            value={activeId}
            onValueChange={(next) => setActiveId(next as AgreementDoc['id'])}
            options={documents.map((document) => ({
              value: document.id,
              label: document.title?.split('/')[0]?.trim()
                || TAB_FALLBACK_TITLE[document.id]
                || document.id,
            }))}
          />
        </div>
      ) : null}

      {active && (active.declaredVersion || active.effectiveDate) ? (
        <p className="mt-1.5 px-0.5 text-meta leading-relaxed text-muted-foreground">
          {active.declaredVersion ? `版本 / Version ${active.declaredVersion}` : ''}
          {active.declaredVersion && active.effectiveDate ? ' · ' : ''}
          {active.effectiveDate ? `生效 / Effective ${active.effectiveDate}` : ''}
        </p>
      ) : null}

      <div
        tabIndex={0}
        aria-label={active?.title ? `${active.title}正文` : '协议正文'}
        className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-2xl border border-border/80 bg-background/55 p-3 outline-none shadow-[inset_0_1px_2px_rgb(0_0_0/0.06)] focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/30 sm:p-5"
      >
        <div className="mx-auto max-w-3xl">
          {active ? (
            <Markdown content={active.text} />
          ) : (
            <p className="text-sm text-muted-foreground">未能加载协议文本，请刷新页面重试。</p>
          )}
        </div>
      </div>

      <button
        type="button"
        onClick={() => setAgreed((current) => !current)}
        aria-pressed={agreed}
        className={cn(
          'mt-3 flex min-h-11 w-full items-center gap-3 rounded-xl border px-3.5 py-2.5 text-start outline-none transition-[background-color,border-color,box-shadow] duration-150 focus-visible:ring-[3px] focus-visible:ring-ring/40 sm:min-h-12 sm:px-4 sm:py-3',
          agreed
            ? 'border-primary/60 bg-primary/5'
            : 'border-border hover:border-primary/40 hover:bg-accent/40',
        )}
      >
        <span
          className={cn(
            'flex size-5 shrink-0 items-center justify-center rounded-[5px] border-2 transition-colors',
            agreed
              ? 'border-primary bg-primary text-primary-foreground'
              : 'border-muted-foreground/50 bg-background',
          )}
        >
          {agreed ? <Check className="size-3.5" strokeWidth={3} /> : null}
        </span>
        <span className="text-sm font-medium leading-relaxed">我已阅读并同意《用户协议》与《隐私政策》</span>
      </button>

      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 flex items-center gap-3 sm:justify-between">
        <span className="hidden text-micro text-muted-foreground/70 sm:inline">
          agreements {version.slice(0, 8)}
        </span>
        <div className="grid w-full grid-cols-2 gap-3 sm:ml-auto sm:flex sm:w-auto sm:items-center">
          <Button type="button" variant="outline" onClick={onDecline} disabled={submitting} className="h-11 w-full sm:w-auto">
            不同意并退出
          </Button>
          <Button type="button" onClick={() => { void accept(); }} disabled={!agreed || submitting} className="h-11 w-full sm:min-w-36 sm:w-auto">
            <ShieldCheck className="size-4" />
            {submitting ? '提交中…' : '同意并继续'}
          </Button>
        </div>
      </div>
    </div>
  );
}

function PasswordStep({
  knownOldPassword,
  mode,
  checkStrength,
  submit,
  onComplete,
}: {
  knownOldPassword?: string;
  mode: 'change' | 'rehearsal';
  checkStrength: (password: string) => Promise<{ rules: PasswordRule[]; valid: boolean }>;
  submit: (
    oldPassword: string,
    newPassword: string,
  ) => Promise<{ success: boolean; message?: string }>;
  onComplete: () => void;
}) {
  const { back } = useWizardNavigation();

  return (
    <div className="mx-auto flex min-h-full w-full max-w-xl flex-col justify-center py-2 sm:py-5">
      <div className="mb-8 flex items-start gap-4">
        <div className="flex size-12 shrink-0 items-center justify-center rounded-2xl bg-primary/10 ring-1 ring-primary/20">
          <ShieldAlert className="size-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-balance text-lg font-semibold tracking-tight sm:text-xl">设置新的访问密码</h2>
          <p className="mt-1 text-pretty text-sm leading-relaxed text-muted-foreground">
            {mode === 'rehearsal'
              ? '验证密码设置步骤的界面与规则；本次演练不会保存输入内容。'
              : '将首次启动生成的临时密码替换为符合要求的强密码。'}
          </p>
        </div>
      </div>
      <ChangePasswordForm
        knownOldPassword={knownOldPassword}
        mode={mode}
        checkStrength={checkStrength}
        submit={submit}
        onSuccess={onComplete}
        idPrefix="onboarding-cpw"
        submitLabel={mode === 'rehearsal' ? '完成演练' : '保存并完成'}
        className="gap-5"
        renderActions={({ canSubmit, submitting, submitLabel }) => (
          <div className="grid gap-3 pt-2 sm:flex sm:items-center">
            <Button type="button" variant="outline" onClick={back} disabled={submitting} className="h-11 w-full sm:w-auto">
              上一步
            </Button>
            <Button type="submit" disabled={!canSubmit} className="h-11 w-full sm:ml-auto sm:min-w-36 sm:w-auto">
              {submitting ? (
                <>
                  <Loader2 className="size-4 animate-spin" /> 提交中…
                </>
              ) : submitLabel}
            </Button>
          </div>
        )}
      />
    </div>
  );
}
