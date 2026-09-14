import { describe, expect, it } from 'vitest';
import { normalizeOneBotConfig } from '../src/lib/onebot-config';

describe('normalizeOneBotConfig history sync', () => {
  it('defaults older payloads to disabled', () => {
    expect(normalizeOneBotConfig({}).historySync).toEqual({ enabled: false });
  });

  it('preserves an explicit per-account opt-in', () => {
    expect(normalizeOneBotConfig({
      historySync: { enabled: true },
    }).historySync).toEqual({ enabled: true });
  });
});
