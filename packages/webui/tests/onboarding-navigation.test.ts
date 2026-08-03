import { describe, expect, it } from 'vitest';
import {
  browserPath,
  DEVELOPER_ONBOARDING_RETURN_KEY,
  developerOnboardingReturnPath,
  isDeveloperOnboardingLocation,
} from '../src/lib/onboarding-navigation';

describe('developer onboarding navigation', () => {
  it('recognizes only the dedicated developer replay URL', () => {
    expect(isDeveloperOnboardingLocation({
      pathname: '/onboarding',
      search: '?mode=developer',
    })).toBe(true);
    expect(isDeveloperOnboardingLocation({ pathname: '/onboarding', search: '' })).toBe(false);
    expect(isDeveloperOnboardingLocation({
      pathname: '/settings',
      search: '?mode=developer',
    })).toBe(false);
  });

  it('preserves the complete local return path', () => {
    expect(browserPath({
      pathname: '/settings',
      search: '?tab=developer',
      hash: '#tools',
    })).toBe('/settings?tab=developer#tools');
  });

  it('accepts only local non-onboarding return paths from history state', () => {
    expect(developerOnboardingReturnPath({
      [DEVELOPER_ONBOARDING_RETURN_KEY]: '/settings?tab=developer',
    })).toBe('/settings?tab=developer');
    expect(developerOnboardingReturnPath({
      [DEVELOPER_ONBOARDING_RETURN_KEY]: 'https://example.com',
    })).toBeNull();
    expect(developerOnboardingReturnPath({
      [DEVELOPER_ONBOARDING_RETURN_KEY]: '//example.com',
    })).toBeNull();
    expect(developerOnboardingReturnPath({
      [DEVELOPER_ONBOARDING_RETURN_KEY]: '/onboarding?mode=developer',
    })).toBeNull();
  });
});
