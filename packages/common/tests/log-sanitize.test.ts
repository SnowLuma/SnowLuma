import { describe, expect, it } from 'vitest';
import { sanitizeLogLine } from '../src/log-sanitize';

describe('sanitizeLogLine', () => {
    it('removes SGR styling in seven-bit and eight-bit forms', () => {
        expect(sanitizeLogLine('\x1b[31mred\x1b[0m / \u009b32mgreen\u009b0m')).toBe('red / green');
    });

    it('removes OSC hyperlinks without removing their visible label', () => {
        expect(sanitizeLogLine('\x1b]8;;https://example.com\x07visible\x1b]8;;\x07')).toBe(
            'visible',
        );
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

    it('preserves long Unicode records and adjacent visible spans', () => {
        const body = '消息 🌌 e\u0301\tpacket=0011aabb\n'.repeat(1000);
        expect(sanitizeLogLine(body)).toBe(body);
        expect(sanitizeLogLine(`\x1b[32m${body}\x1b[0m\x00tail\x1b`)).toBe(`${body}tail`);
    });

    it.each(['\x1bP', '\x1bX', '\x1b^', '\x1b_', '\u0090', '\u0098', '\u009e', '\u009f'])(
        'removes %j control strings between visible spans',
        (opener) => {
            expect(sanitizeLogLine(`before${opener}private\u009cafter`)).toBe('beforeafter');
            expect(sanitizeLogLine(`before${opener}private\x1b\\after`)).toBe('beforeafter');
            expect(sanitizeLogLine(`before${opener}private`)).toBe('before');
        },
    );

    it('handles consecutive controls and records consisting only of controls', () => {
        expect(sanitizeLogLine('\x00\x1b[31m\u009b0m\r\u007f')).toBe('');
        expect(sanitizeLogLine('a\x00\x1b[31m\u009b0m\r\u007fb')).toBe('ab');
        expect(sanitizeLogLine('')).toBe('');
    });
});
