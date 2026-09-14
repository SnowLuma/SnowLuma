import { describe, expect, it } from 'vitest';
import { parseSecondFactor } from '../src/lib/totp-second-factor';

describe('parseSecondFactor', () => {
  it('treats a 6-digit code as TOTP, ignoring spaces', () => {
    expect(parseSecondFactor('287 082')).toEqual({ totp: '287082' });
  });

  it('treats a recovery code as a recovery code', () => {
    expect(parseSecondFactor('AB3D-K7MQ')).toEqual({ recoveryCode: 'AB3D-K7MQ' });
  });
});
