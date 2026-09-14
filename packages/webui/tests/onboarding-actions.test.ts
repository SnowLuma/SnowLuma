import { describe, expect, it, vi } from 'vitest';
import { onboardingExecution } from '../src/lib/onboarding-actions';

describe('developer onboarding rehearsal', () => {
  it('completes consent and password steps without writing persistent state', async () => {
    const acceptAgreements = vi.fn(async () => ({ success: true }));
    const changePassword = vi.fn(async () => ({ success: true }));
    const execution = onboardingExecution(true, {
      acceptAgreements,
      changePassword,
    });

    expect(execution.passwordMode).toBe('rehearsal');
    await expect(execution.actions.acceptAgreements()).resolves.toEqual({ success: true });
    await expect(execution.actions.changePassword('old', 'new')).resolves.toEqual({ success: true });
    expect(acceptAgreements).not.toHaveBeenCalled();
    expect(changePassword).not.toHaveBeenCalled();
  });

  it('keeps real onboarding wired to persistent actions', async () => {
    const acceptAgreements = vi.fn(async () => ({ success: true }));
    const changePassword = vi.fn(async () => ({ success: true }));
    const execution = onboardingExecution(false, {
      acceptAgreements,
      changePassword,
    });

    expect(execution.passwordMode).toBe('change');
    await execution.actions.acceptAgreements();
    await execution.actions.changePassword('old', 'new');
    expect(acceptAgreements).toHaveBeenCalledOnce();
    expect(changePassword).toHaveBeenCalledWith('old', 'new');
  });
});
