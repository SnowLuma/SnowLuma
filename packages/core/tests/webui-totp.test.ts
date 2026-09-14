import { describe, expect, it } from 'vitest';
import { prepareWebuiAuthStateForRestore } from '../src/webui/auth';
import {
  beginTotpEnrollment,
  confirmTotpEnrollment,
  consumeRecoveryCode,
  decideSecondFactorLogin,
  generateRecoveryCodes,
  hashRecoveryCode,
  parseTotpStateLenient,
  prepareTotpStateForRestore,
  regenerateRecoveryCodes,
  rewrapTotpSecret,
  unwrapTotpSecret,
  verifySecondFactor,
  verifyTotpCode,
  wrapTotpSecret,
} from '../src/webui/totp';

// RFC 6238 Appendix B, SHA-1, secret ASCII "12345678901234567890".
// 8-digit vector at T=59 is 94287082; 6-digit TOTP is that value mod 10^6.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';
const T59_MS = 59_000;
const T59_CODE = '287082';
const T1111111109_MS = 1_111_111_109_000;
const T1111111109_CODE = '081804';
const PASSWORD = 'Correct-Horse-1!';

describe('verifyTotpCode', () => {
  it('accepts the RFC 6238 SHA-1 6-digit code at T=59', () => {
    expect(verifyTotpCode(RFC_SECRET, T59_CODE, T59_MS)).toEqual({ ok: true, step: 1 });
  });

  it('rejects a wrong 6-digit code at the same instant', () => {
    expect(verifyTotpCode(RFC_SECRET, '000000', T59_MS)).toEqual({ ok: false });
  });

  it('rejects the same time-step being used twice', () => {
    expect(verifyTotpCode(RFC_SECRET, T59_CODE, T59_MS, 1)).toEqual({ ok: false });
  });
});

describe('wrapTotpSecret', () => {
  it('round-trips a TOTP secret with the wrapping password', () => {
    const wrapped = wrapTotpSecret(PASSWORD, RFC_SECRET);
    expect(wrapped.ciphertext.toLowerCase()).not.toContain(
      Buffer.from(RFC_SECRET, 'utf8').toString('hex'),
    );
    expect(unwrapTotpSecret(PASSWORD, wrapped)).toBe(RFC_SECRET);
  });

  it('returns null when the wrapping password is wrong', () => {
    const wrapped = wrapTotpSecret(PASSWORD, RFC_SECRET);
    expect(unwrapTotpSecret('Wrong-Password-2!', wrapped)).toBeNull();
  });
});

describe('recovery codes', () => {
  it('generates 8 XXXX-XXXX codes that each verify once', () => {
    const codes = generateRecoveryCodes();
    expect(codes).toHaveLength(8);
    expect(new Set(codes).size).toBe(8);
    for (const code of codes) {
      expect(code).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    }

    const hashes = codes.map(hashRecoveryCode);
    const first = consumeRecoveryCode(codes[0]!, hashes);
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.remainingHashes).toHaveLength(7);
    expect(consumeRecoveryCode(codes[0]!, first.remainingHashes)).toEqual({ ok: false });
  });
});

describe('totp enrollment and second factor', () => {
  it('enables 2FA only after a matching TOTP code and then accepts a later code', () => {
    const enrollment = beginTotpEnrollment({
      issuer: 'SnowLuma',
      accountName: 'testhost',
      secret: RFC_SECRET,
    });
    expect(enrollment.otpauthUrl).toContain('otpauth://totp/');
    expect(enrollment.otpauthUrl).toContain('secret=GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ');
    expect(enrollment.otpauthUrl).toContain('issuer=SnowLuma');

    expect(() => confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: '000000',
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    })).toThrow(/验证码/);

    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    expect(enabled.recoveryCodes).toHaveLength(8);
    expect(enabled.state.lastUsedStep).toBe(1);
    expect(enabled.state.label).toBe('SnowLuma (testhost)');
    expect(enabled.state.recoveryCodeHashes).toHaveLength(8);

    expect(verifySecondFactor({
      password: PASSWORD,
      totp: T59_CODE,
      state: enabled.state,
      atMs: T59_MS,
    })).toEqual({ ok: false });

    const later = verifySecondFactor({
      password: PASSWORD,
      totp: T1111111109_CODE,
      state: enabled.state,
      atMs: T1111111109_MS,
    });
    expect(later.ok).toBe(true);
    if (!later.ok) return;
    expect(later.state.lastUsedStep).toBeGreaterThan(enabled.state.lastUsedStep);
  });

  it('accepts a recovery code at login and consumes only that hash', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    const used = enabled.recoveryCodes[3]!;
    const result = verifySecondFactor({
      password: PASSWORD,
      recoveryCode: used,
      state: enabled.state,
      atMs: T59_MS,
    });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.state.recoveryCodeHashes).toHaveLength(7);
    expect(verifySecondFactor({
      password: PASSWORD,
      recoveryCode: used,
      state: result.state,
      atMs: T59_MS,
    })).toEqual({ ok: false });
  });

  it('re-wraps the TOTP secret when the password changes', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    const nextPassword = 'Correct-Horse-2!';
    const rewrapped = rewrapTotpSecret(PASSWORD, nextPassword, enabled.state);
    expect(unwrapTotpSecret(nextPassword, rewrapped)).toBe(RFC_SECRET);
    expect(unwrapTotpSecret(PASSWORD, rewrapped)).toBeNull();
    expect(verifySecondFactor({
      password: nextPassword,
      totp: T1111111109_CODE,
      state: rewrapped,
      atMs: T1111111109_MS,
    }).ok).toBe(true);
  });
});

describe('totp persistence', () => {
  it('round-trips a valid persisted totp object for backup restore', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    const restored = prepareTotpStateForRestore(JSON.parse(JSON.stringify(enabled.state)));
    expect(restored).toEqual(enabled.state);
  });

  it('rejects a malformed totp object on restore', () => {
    expect(() => prepareTotpStateForRestore({ wrapSalt: 'zz' })).toThrow(/totp/i);
  });

  it('treats a malformed totp object as absent when loading live config', () => {
    expect(parseTotpStateLenient({ wrapSalt: 'zz' })).toBeUndefined();
    expect(parseTotpStateLenient(undefined)).toBeUndefined();
  });

  it('keeps totp on credential restore and rejects a malformed totp object', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    const base = {
      passwordHash: 'ab'.repeat(64),
      passwordSalt: 'cd'.repeat(16),
      mustChangePassword: false,
      generatedAt: '2026-06-18T00:00:00.000Z',
      updatedAt: '2026-06-18T00:00:00.000Z',
    };
    expect(prepareWebuiAuthStateForRestore({ ...base, totp: enabled.state }).totp).toEqual(enabled.state);
    expect(() => prepareWebuiAuthStateForRestore({ ...base, totp: { wrapSalt: 'zz' } })).toThrow(/totp/i);
  });
});

describe('decideSecondFactorLogin', () => {
  it('asks for TOTP when 2FA is on and the request has no second factor', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    expect(decideSecondFactorLogin({
      totpEnabled: true,
      state: enabled.state,
      password: PASSWORD,
      atMs: T59_MS,
    })).toEqual({ kind: 'needs-totp' });
  });

  it('skips the second factor when 2FA is off', () => {
    expect(decideSecondFactorLogin({
      totpEnabled: false,
      password: PASSWORD,
      totp: '000000',
      atMs: T59_MS,
    })).toEqual({ kind: 'ok' });
  });
});

describe('regenerateRecoveryCodes', () => {
  it('replaces every recovery hash after a valid TOTP', () => {
    const enabled = confirmTotpEnrollment({
      password: PASSWORD,
      secret: RFC_SECRET,
      code: T59_CODE,
      label: 'SnowLuma (testhost)',
      atMs: T59_MS,
    });
    const oldCode = enabled.recoveryCodes[0]!;
    const next = regenerateRecoveryCodes({
      password: PASSWORD,
      state: enabled.state,
      totp: T1111111109_CODE,
      atMs: T1111111109_MS,
    });
    expect(next.recoveryCodes).toHaveLength(8);
    expect(next.recoveryCodes).not.toContain(oldCode);
    expect(verifySecondFactor({
      password: PASSWORD,
      recoveryCode: oldCode,
      state: next.state,
      atMs: T1111111109_MS,
    })).toEqual({ ok: false });
    expect(verifySecondFactor({
      password: PASSWORD,
      recoveryCode: next.recoveryCodes[0]!,
      state: next.state,
      atMs: T1111111109_MS,
    }).ok).toBe(true);
  });
});
