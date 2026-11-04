import { describe, expect, it } from 'vitest';
import { execFileSync } from 'node:child_process';
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

    it('preserves every visible UTF-16 code unit when removing a large hidden payload', () => {
        const visible = 'visible 🌌 e\u0301\ud800x\udc00';
        expect(sanitizeLogLine(`${visible}\x1b]${'hidden'.repeat(1000)}`)).toBe(visible);
    });

    it('does not retain discarded control-string payloads through a short visible span', () => {
        const moduleUrl = new URL('../src/log-sanitize.ts', import.meta.url).href;
        const output = execFileSync(
            process.execPath,
            [
                '--expose-gc',
                '--input-type=module',
                '-e',
                `
                import { setImmediate } from 'node:timers/promises';
                import { sanitizeLogLine } from ${JSON.stringify(moduleUrl)};
                async function used() {
                    await setImmediate();
                    global.gc();
                    global.gc();
                    return process.memoryUsage().heapUsed;
                }
                function record(i) {
                    return sanitizeLogLine('visible record ' + i + '\\x1b]' + 'x'.repeat(1024 * 1024));
                }
                const before = await used();
                const records = Array.from({ length: 16 }, (_, i) => record(i));
                const retained = (await used()) - before;
                console.log(JSON.stringify({ retained, records }));
            `,
            ],
            { encoding: 'utf8', timeout: 10_000 },
        );
        const result = JSON.parse(output);
        expect(result.records).toEqual(Array.from({ length: 16 }, (_, i) => `visible record ${i}`));
        // Leave ample GC/runtime overhead while rejecting retention of the 16 MiB input.
        expect(result.retained).toBeLessThan(4 * 1024 * 1024);
    });
});
