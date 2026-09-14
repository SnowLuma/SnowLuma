import { describe, expect, it } from 'vitest';
import { DebounceMachine } from '../src/notifications/debounce';

describe('DebounceMachine — online↔offline debounce (Uptime-Kuma semantics)', () => {
  it('a cold online (no prior offline) fires nothing', () => {
    const m = new DebounceMachine();
    expect(m.onOnline('u')).toEqual({ kind: 'none' });
  });

  it('an offline that self-heals within the window fires nothing', () => {
    const m = new DebounceMachine();
    expect(m.onOffline('u', 30)).toEqual({ kind: 'schedule', delayMs: 30_000 });
    expect(m.onOnline('u')).toEqual({ kind: 'cancel' });
    // back to baseline — a later offline schedules fresh
    expect(m.onOffline('u', 30)).toEqual({ kind: 'schedule', delayMs: 30_000 });
  });

  it('an offline that survives the window fires offline, then recovery fires online (paired)', () => {
    const m = new DebounceMachine();
    expect(m.onOffline('u', 30)).toEqual({ kind: 'schedule', delayMs: 30_000 });
    expect(m.onTimerElapsed('u')).toEqual({ kind: 'emit', event: 'offline' });
    expect(m.onOnline('u')).toEqual({ kind: 'emit', event: 'online' });
    // after recovery completes, the next online is cold again
    expect(m.onOnline('u')).toEqual({ kind: 'none' });
  });

  it('debounceSeconds<=0 fires offline immediately', () => {
    const m = new DebounceMachine();
    expect(m.onOffline('u', 0)).toEqual({ kind: 'emit', event: 'offline' });
    expect(m.onOnline('u')).toEqual({ kind: 'emit', event: 'online' });
  });

  it('treats a non-finite debounceSeconds as no-debounce (fires immediately)', () => {
    const m = new DebounceMachine();
    expect(m.onOffline('u', Number.NaN)).toEqual({ kind: 'emit', event: 'offline' });
  });

  it('a second offline while pending is a no-op', () => {
    const m = new DebounceMachine();
    expect(m.onOffline('u', 30)).toEqual({ kind: 'schedule', delayMs: 30_000 });
    expect(m.onOffline('u', 30)).toEqual({ kind: 'none' });
  });

  it('a second offline after one already fired is a no-op', () => {
    const m = new DebounceMachine();
    m.onOffline('u', 0); // fires offline
    expect(m.onOffline('u', 0)).toEqual({ kind: 'none' });
  });

  it('a timer elapsing after a cancel is a no-op (stale timer)', () => {
    const m = new DebounceMachine();
    m.onOffline('u', 30); // schedule
    m.onOnline('u'); // cancel
    expect(m.onTimerElapsed('u')).toEqual({ kind: 'none' });
  });

  it('tracks UINs independently', () => {
    const m = new DebounceMachine();
    expect(m.onOffline('a', 0)).toEqual({ kind: 'emit', event: 'offline' });
    expect(m.onOffline('b', 30)).toEqual({ kind: 'schedule', delayMs: 30_000 });
    expect(m.onOnline('b')).toEqual({ kind: 'cancel' });
    expect(m.onOnline('a')).toEqual({ kind: 'emit', event: 'online' });
  });

  it('forget() resets a UIN to baseline', () => {
    const m = new DebounceMachine();
    m.onOffline('u', 0); // fired offline
    m.forget('u');
    expect(m.onOnline('u')).toEqual({ kind: 'none' }); // state cleared → no recovery
  });
});
