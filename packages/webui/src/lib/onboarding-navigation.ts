export const DEVELOPER_ONBOARDING_URL = '/onboarding?mode=developer';
export const DEVELOPER_SETTINGS_URL = '/settings?tab=developer';
export const DEVELOPER_ONBOARDING_RETURN_KEY = 'snowlumaOnboardingReturnTo';

interface LocationLike {
  pathname: string;
  search: string;
  hash?: string;
}

export function isDeveloperOnboardingLocation(location: LocationLike): boolean {
  if (location.pathname !== '/onboarding') return false;
  return new URLSearchParams(location.search).get('mode') === 'developer';
}

export function browserPath(location: LocationLike): string {
  return `${location.pathname}${location.search}${location.hash ?? ''}`;
}

export function developerOnboardingReturnPath(state: unknown): string | null {
  if (typeof state !== 'object' || state === null) return null;
  const candidate = (state as Record<string, unknown>)[DEVELOPER_ONBOARDING_RETURN_KEY];
  if (typeof candidate !== 'string') return null;
  if (!candidate.startsWith('/') || candidate.startsWith('//')) return null;
  if (candidate.startsWith('/onboarding')) return null;
  return candidate;
}
