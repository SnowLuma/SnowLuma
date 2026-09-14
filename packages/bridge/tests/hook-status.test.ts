import { describe, it, expect } from 'vitest';
import { statusFor, type HookFlags } from '../src/hook-status';
import type { HookProcessStatus } from '../src/types';

const F = (o: Partial<HookFlags>): HookFlags => ({
  injected: false, connected: false, loggedIn: false, wasLoggedIn: false, ...o,
});

describe('statusFor — settled HookProcessStatus derivation', () => {
  it('not injected → available (regardless of other flags)', () => {
    expect(statusFor(F({ injected: false }))).toBe('available');
    // !injected dominates: stale connected/loggedIn bits must not leak through.
    expect(statusFor(F({ injected: false, connected: true, loggedIn: true, wasLoggedIn: true }))).toBe('available');
  });

  it('injected, connected, loggedIn → online', () => {
    expect(statusFor(F({ injected: true, connected: true, loggedIn: true }))).toBe('online');
  });

  it('injected, connected, not loggedIn → loaded', () => {
    expect(statusFor(F({ injected: true, connected: true, loggedIn: false }))).toBe('loaded');
  });

  it('injected, not connected, had logged in → disconnected', () => {
    expect(statusFor(F({ injected: true, connected: false, wasLoggedIn: true }))).toBe('disconnected');
  });

  it('injected, not connected, never logged in → connecting', () => {
    expect(statusFor(F({ injected: true, connected: false, wasLoggedIn: false }))).toBe('connecting');
  });

  it('disconnected vs connecting differ ONLY by wasLoggedIn (same injected+!connected)', () => {
    const base = { injected: true, connected: false, loggedIn: false };
    expect(statusFor(F({ ...base, wasLoggedIn: true }))).toBe('disconnected');
    expect(statusFor(F({ ...base, wasLoggedIn: false }))).toBe('connecting');
  });

  it('covers exactly the five settled states across the flag space', () => {
    const seen = new Set<HookProcessStatus>();
    for (const injected of [false, true]) {
      for (const connected of [false, true]) {
        for (const loggedIn of [false, true]) {
          for (const wasLoggedIn of [false, true]) {
            seen.add(statusFor({ injected, connected, loggedIn, wasLoggedIn }));
          }
        }
      }
    }
    expect([...seen].sort()).toEqual(
      ['available', 'connecting', 'disconnected', 'loaded', 'online'].sort(),
    );
    // The two out-of-band states are never produced by the pure derivation.
    expect(seen.has('loading')).toBe(false);
    expect(seen.has('error')).toBe(false);
  });
});
