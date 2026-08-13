import { describe, expect, it } from 'vitest';
import { confirmTotpEnrollment } from '../src/webui/totp';
import { completeWebuiLogin, invalidateOtherSessions, type WebuiLoginAuth } from '../src/webui/webui-login';

const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const T59_MS = 59_000;
const T59_CODE = '287082';
const PASSWORD = 'Correct-Horse-1!';

function authWithoutTotp(): WebuiLoginAuth {
  return {
    verify: (password) => password === PASSWORD,
    totpEnabled: () => false,
    totpState: () => undefined,
    mustChangePassword: () => false,
  };
}

describe('completeWebuiLogin', () => {
  it('rejects a wrong password without mentioning TOTP', () => {
    expect(completeWebuiLogin(authWithoutTotp(), { password: 'nope' }, T59_MS)).toEqual({
      kind: 'bad-password',
    });
  });

  it('logs in with only a password when 2FA is off', () => {
    expect(completeWebuiLogin(authWithoutTotp(), { password: PASSWORD }, T59_MS)).toEqual({
      kind: 'ok',
      mustChangePassword: false,
    });
  });

  it('asks for TOTP after a correct password when 2FA is on', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    const auth: WebuiLoginAuth = {
      verify: (password) => password === PASSWORD,
      totpEnabled: () => true,
      totpState: () => enabled.state,
      mustChangePassword: () => false,
    };
    expect(completeWebuiLogin(auth, { password: PASSWORD }, T59_MS)).toEqual({
      kind: 'needs-totp',
    });
  });

  it('accepts password plus TOTP and returns the updated totp state', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    const auth: WebuiLoginAuth = {
      verify: (password) => password === PASSWORD,
      totpEnabled: () => true,
      totpState: () => enabled.state,
      mustChangePassword: () => true,
    };
    const result = completeWebuiLogin(
      auth,
      { password: PASSWORD, totp: '081804' },
      1_111_111_109_000,
    );
    expect(result.kind).toBe('ok');
    if (result.kind !== 'ok') return;
    expect(result.mustChangePassword).toBe(true);
    expect(result.totpState?.lastUsedStep).toBeGreaterThan(enabled.state.lastUsedStep);
  });
});

describe('invalidateOtherSessions', () => {
  it('keeps the current session and drops the rest', () => {
    const sessions = new Map([
      ['keep', { n: 1 }],
      ['drop-a', { n: 2 }],
      ['drop-b', { n: 3 }],
    ]);
    invalidateOtherSessions(sessions, 'keep');
    expect([...sessions.keys()]).toEqual(['keep']);
  });
});
