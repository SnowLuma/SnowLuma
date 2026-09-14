import { describe, expect, it } from 'vitest';
import { sanitizeLogLine } from '../src/log-sanitize';

describe('sanitizeLogLine', () => {
  it('removes SGR styling in seven-bit and eight-bit forms', () => {
    expect(sanitizeLogLine('\x1b[31mred\x1b[0m / \u009b32mgreen\u009b0m')).toBe('red / green');
  });

  it('removes OSC hyperlinks without removing their visible label', () => {
    expect(
      sanitizeLogLine('\x1b]8;;https://example.com\x07visible\x1b]8;;\x07'),
    ).toBe('visible');
  });

  it('removes terminal control-string payloads', () => {
    expect(sanitizeLogLine('before\x1bPprivate payload\x1b\\after')).toBe('beforeafter');
  });

  it('preserves tabs and newlines while removing other controls', () => {
    expect(sanitizeLogLine('one\ttwo\nthree\r\x00')).toBe('one\ttwo\nthree');
  });

  it('does not leak unterminated terminal strings', () => {
    expect(sanitizeLogLine('visible\x1b]8;;https://example.com')).toBe('visible');
  });
});
