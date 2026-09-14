export function parseSecondFactor(value: string): { totp: string } | { recoveryCode: string } {
  const trimmed = value.trim();
  const digits = trimmed.replace(/\s/g, '');
  if (/^\d{6}$/.test(digits)) return { totp: digits };
  return { recoveryCode: trimmed };
}
