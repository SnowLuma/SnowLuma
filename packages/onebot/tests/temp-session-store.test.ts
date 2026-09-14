import { describe, expect, it } from 'vitest';
import { TempSessionStore, TEMP_SESSION_TTL_MS } from '../src/temp-session-store';

const T0 = 1_700_000_000_000;

describe('TempSessionStore (passive temp-session gate, #212-temp)', () => {
  it('a recorded session is authorized; an unrecorded one is NOT (the core gate)', () => {
    const s = new TempSessionStore();
    s.record(1001, 700, T0);
    // Recorded (user, group) → allowed.
    expect(s.has(1001, 700, T0)).toBe(true);
    // Never recorded → refused. This is what makes send passive-only: the bot
    // cannot reply to a (user, group) that never messaged it first.
    expect(s.has(1001, 701, T0)).toBe(false); // same user, different group
    expect(s.has(1002, 700, T0)).toBe(false); // different user, same group
    expect(s.has(9999, 9999, T0)).toBe(false); // wholly unknown
  });

  it('sessions are keyed per (user, group) — one user, many groups', () => {
    const s = new TempSessionStore();
    s.record(1001, 700, T0);
    s.record(1001, 800, T0);
    expect(s.has(1001, 700, T0)).toBe(true);
    expect(s.has(1001, 800, T0)).toBe(true);
    expect(s.has(1001, 900, T0)).toBe(false);
  });

  it('expires exactly at TTL and prunes on read', () => {
    const s = new TempSessionStore();
    s.record(1001, 700, T0);
    // Just before expiry: still valid.
    expect(s.has(1001, 700, T0 + TEMP_SESSION_TTL_MS - 1)).toBe(true);
    // At/after expiry: gone.
    expect(s.has(1001, 700, T0 + TEMP_SESSION_TTL_MS)).toBe(false);
    // A later inbound message refreshes the window.
    s.record(1001, 700, T0 + TEMP_SESSION_TTL_MS);
    expect(s.has(1001, 700, T0 + TEMP_SESSION_TTL_MS + 1)).toBe(true);
  });

  it('ignores invalid records (no group / no user) — stays receive-only', () => {
    const s = new TempSessionStore();
    s.record(1001, 0, T0);   // no source group
    s.record(0, 700, T0);    // no user
    s.record(-5, -5, T0);
    expect(s.has(1001, 0, T0)).toBe(false);
    expect(s.has(0, 700, T0)).toBe(false);
  });

  it('sweep drops expired entries', () => {
    const s = new TempSessionStore();
    s.record(1001, 700, T0);
    s.record(1002, 700, T0 + TEMP_SESSION_TTL_MS); // expires later
    s.sweep(T0 + TEMP_SESSION_TTL_MS + 1);
    expect(s.has(1001, 700, T0 + TEMP_SESSION_TTL_MS + 1)).toBe(false);
    expect(s.has(1002, 700, T0 + TEMP_SESSION_TTL_MS + 1)).toBe(true);
  });
});
