export interface OnboardingActionResult {
  success: boolean;
  message?: string;
}

export interface OnboardingActions {
  acceptAgreements: () => Promise<OnboardingActionResult>;
  changePassword: (
    oldPassword: string,
    newPassword: string,
  ) => Promise<OnboardingActionResult>;
}

export interface OnboardingExecution {
  passwordMode: 'change' | 'rehearsal';
  actions: OnboardingActions;
}

const REHEARSAL_ACTIONS: OnboardingActions = {
  acceptAgreements: async () => ({ success: true }),
  changePassword: async () => ({ success: true }),
};

export function onboardingExecution(
  replaying: boolean,
  liveActions: OnboardingActions,
): OnboardingExecution {
  return replaying
    ? { passwordMode: 'rehearsal', actions: REHEARSAL_ACTIONS }
    : { passwordMode: 'change', actions: liveActions };
}
