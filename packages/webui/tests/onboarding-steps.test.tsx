import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { WizardSteps } from '../src/components/interior/wizard-steps';
import {
  advanceOnboardingStep,
  buildRequiredOnboardingStepIds,
} from '../src/components/pages/onboarding-steps';

describe('buildRequiredOnboardingStepIds', () => {
  it('keeps legal consent before password setup when both are required', () => {
    expect(buildRequiredOnboardingStepIds({
      needsConsent: true,
      mustChangePassword: true,
    })).toEqual(['agreements', 'password']);
  });

  it('omits steps already satisfied by backend environment-aware policy', () => {
    expect(buildRequiredOnboardingStepIds({
      needsConsent: false,
      mustChangePassword: false,
    })).toEqual([]);
    expect(buildRequiredOnboardingStepIds({
      needsConsent: false,
      mustChangePassword: true,
    })).toEqual(['password']);
  });

  it('completes consent and password in order before releasing onboarding', () => {
    const steps = buildRequiredOnboardingStepIds({
      needsConsent: true,
      mustChangePassword: true,
    });

    expect(advanceOnboardingStep(steps, 'agreements')).toEqual({
      nextIndex: 1,
      complete: false,
    });
    expect(advanceOnboardingStep(steps, 'password')).toEqual({
      nextIndex: null,
      complete: true,
    });
  });
});

describe('WizardSteps onboarding policy', () => {
  it('only renders a skip action for a step configured as skippable', () => {
    const skippable = renderToStaticMarkup(
      <WizardSteps
        steps={[
          { id: 'optional', label: '可选步骤', content: <p>可选内容</p>, canSkip: true },
          { id: 'required', label: '必要步骤', content: <p>必要内容</p> },
        ]}
        skipLabel="跳过"
      />,
    );
    const required = renderToStaticMarkup(
      <WizardSteps
        steps={[
          { id: 'required', label: '必要步骤', content: <p>必要内容</p>, canSkip: false },
        ]}
        skipLabel="跳过"
      />,
    );

    expect(skippable).toContain('跳过');
    expect(required).not.toContain('跳过');
  });
});
