import { useState, type ReactNode } from 'react';
import { Check, ScrollText, ShieldAlert, ShieldCheck } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { ThemeToggle } from '@/components/theme-toggle';
import { SegmentedControl } from '@/components/interior/segmented-control';
import { WizardSteps, type WizardStep } from '@/components/interior/wizard-steps';
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
      content: (
        <PasswordStep
          knownOldPassword={knownOldPassword}
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
    <div className="relative flex min-h-screen items-center justify-center overflow-x-hidden bg-background px-4 py-6">
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            'radial-gradient(80% 60% at 50% 0%, color-mix(in oklab, var(--primary) 18%, transparent) 0%, transparent 70%)',
        }}
      />
      <div className="absolute right-4 top-4">
        <ThemeToggle />
      </div>
      <main className="relative z-10 w-full max-w-3xl">
        <div className="mb-5">
          <p className="text-xs font-medium text-primary">SnowLuma WebUI</p>
          <h1 className="mt-1 text-xl font-semibold tracking-tight">完成首次使用设置</h1>
          <p className="mt-1 text-sm text-muted-foreground">
            按顺序完成必要步骤后即可进入控制台。
          </p>
        </div>
        <WizardSteps
          steps={steps}
          index={index}
          onIndexChange={setIndex}
          onComplete={onComplete}
          height={520}
          label="首次使用设置步骤"
          backLabel="上一步"
          nextLabel="下一步"
          finishLabel="完成"
          skipLabel="跳过"
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
    <div className="flex min-h-full flex-col">
      <div className="flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
          <ScrollText className="size-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">请阅读并同意以下协议</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            同意一次后无需重复确认；仅当协议内容更新时才会再次请求确认。
          </p>
        </div>
      </div>

      {documents.length > 1 ? (
        <div className="mt-4 max-w-full overflow-x-auto">
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
        <p className="mt-2 text-meta text-muted-foreground">
          {active.declaredVersion ? `版本 / Version ${active.declaredVersion}` : ''}
          {active.declaredVersion && active.effectiveDate ? ' · ' : ''}
          {active.effectiveDate ? `生效 / Effective ${active.effectiveDate}` : ''}
        </p>
      ) : null}

      <div className="mt-3 min-h-48 flex-1 overflow-y-auto rounded-lg border border-border bg-background/60 p-4">
        {active ? (
          <Markdown content={active.text} />
        ) : (
          <p className="text-sm text-muted-foreground">未能加载协议文本，请刷新页面重试。</p>
        )}
      </div>

      <button
        type="button"
        onClick={() => setAgreed((current) => !current)}
        aria-pressed={agreed}
        className={cn(
          'mt-3 flex w-full items-center gap-3 rounded-lg border px-3.5 py-2.5 text-left transition-colors',
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
        <span className="text-sm font-medium">我已阅读并同意《用户协议》与《隐私政策》</span>
      </button>

      {error ? <p role="alert" className="mt-2 text-xs text-destructive">{error}</p> : null}

      <div className="mt-3 flex items-center justify-between gap-2">
        <span className="text-micro text-muted-foreground/70">
          agreements {version.slice(0, 8)}
        </span>
        <div className="flex gap-2">
          <Button type="button" variant="ghost" onClick={onDecline} disabled={submitting}>
            不同意并退出
          </Button>
          <Button type="button" onClick={() => { void accept(); }} disabled={!agreed || submitting}>
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
  checkStrength,
  submit,
  onComplete,
}: {
  knownOldPassword?: string;
  checkStrength: (password: string) => Promise<{ rules: PasswordRule[]; valid: boolean }>;
  submit: (
    oldPassword: string,
    newPassword: string,
  ) => Promise<{ success: boolean; message?: string }>;
  onComplete: () => void;
}) {
  return (
    <div className="mx-auto flex w-full max-w-lg flex-col">
      <div className="mb-5 flex items-start gap-3">
        <div className="flex size-11 shrink-0 items-center justify-center rounded-xl bg-primary/10 ring-1 ring-primary/20">
          <ShieldAlert className="size-5 text-primary" />
        </div>
        <div className="min-w-0">
          <h2 className="text-base font-semibold">设置新的访问密码</h2>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            将首次启动生成的临时密码替换为符合要求的强密码。
          </p>
        </div>
      </div>
      <ChangePasswordForm
        knownOldPassword={knownOldPassword}
        checkStrength={checkStrength}
        submit={submit}
        onSuccess={onComplete}
        idPrefix="onboarding-cpw"
        submitLabel="保存并完成"
      />
    </div>
  );
}
