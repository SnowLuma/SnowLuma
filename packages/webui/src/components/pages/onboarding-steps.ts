export type RequiredOnboardingStepId = 'agreements' | 'password';

export interface OnboardingRequirements {
  needsConsent: boolean;
  mustChangePassword: boolean;
}

/**
 * The server has already applied environment policy before returning these
 * booleans. Accepted legal env flags therefore omit the agreement step, while
 * a configured bootstrap password omits forced password rotation.
 */
export function buildRequiredOnboardingStepIds({
  needsConsent,
  mustChangePassword,
}: OnboardingRequirements): RequiredOnboardingStepId[] {
  const steps: RequiredOnboardingStepId[] = [];
  if (needsConsent) steps.push('agreements');
  if (mustChangePassword) steps.push('password');
  return steps;
}

export type OnboardingAdvance =
  | { nextIndex: number; complete: false }
  | { nextIndex: null; complete: true };

export function advanceOnboardingStep(
  stepIds: readonly string[],
  currentStepId: string,
): OnboardingAdvance {
  const current = stepIds.indexOf(currentStepId);
  if (current < 0) {
    throw new Error(`Unknown onboarding step: ${currentStepId}`);
  }
  if (current === stepIds.length - 1) {
    return { nextIndex: null, complete: true };
  }
  return { nextIndex: current + 1, complete: false };
}
