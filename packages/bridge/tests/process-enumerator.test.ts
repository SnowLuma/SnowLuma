import { describe, it, expect, vi } from 'vitest';
import { createNativeProcessEnumerator } from '../src/process-enumerator';
import type { HookProcessBaseInfo } from '../src/injector';

const QQ = (pid: number): HookProcessBaseInfo => ({ pid, name: 'qq', path: '' });

describe('createNativeProcessEnumerator', () => {
  describe('no addon (macOS / missing) → synchronous fallback, never a worker', () => {
    it('returns the sync lister result', async () => {
      const en = createNativeProcessEnumerator({
        addonPath: null,
        fallbackSync: () => [QQ(10), QQ(20)],
        processName: 'qq',
      });
      expect(await en.enumerate()).toEqual([QQ(10), QQ(20)]);
      en.dispose();
    });

    it('maps a throwing sync lister to UNKNOWN (null), not an empty list', async () => {
      const en = createNativeProcessEnumerator({
        addonPath: null,
        fallbackSync: () => { throw new Error('boom'); },
        processName: 'qq',
      });
      expect(await en.enumerate()).toBeNull();
      en.dispose();
    });
  });

  describe('worker isolation that cannot load the addon → permanent fallback', () => {
    it('falls back to the sync lister after the worker reports a fatal load error', async () => {
      const fallback = vi.fn(() => [QQ(7)]);
      const en = createNativeProcessEnumerator({
        // A path that exists nowhere → process.dlopen throws in the worker →
        // the worker posts 'fatal' → isolation is abandoned for good.
        addonPath: '/nonexistent/snowluma-test.node',
        fallbackSync: fallback,
        processName: 'qq',
        timeoutMs: 200,
      });

      // First call spawns the worker; the fatal message drains it to UNKNOWN.
      const first = await en.enumerate();
      expect(first).toBeNull();

      // Give the 'fatal' message a moment to flip isolationBroken if it hadn't
      // already, then subsequent calls take the synchronous fallback.
      await new Promise((r) => setTimeout(r, 50));
      const second = await en.enumerate();
      expect(second).toEqual([QQ(7)]);
      expect(fallback).toHaveBeenCalled();
      en.dispose();
    });
  });
});
