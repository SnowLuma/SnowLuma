import { describe, expect, it } from 'vitest';
import { compareVersions, parseVersion } from '../src/semver';

describe('parseVersion', () => {
    it.each([
        '0.0.0',
        '1.2.3',
        '1.2.3-rc.1',
        '1.2.3-alpha-beta',
        '1.2.3+001.build',
        '1.2.3-rc.1+build.2',
    ])('accepts canonical SemVer and preserves its full value: %s', (version) => {
        expect(parseVersion(version)?.raw).toBe(version);
    });

    it.each([
        undefined,
        null,
        123,
        {},
        '',
        '1.2',
        '1.2.3.4',
        '1.2.x',
        '01.2.3',
        '1.02.3',
        '1.2.03',
        '1.2.3-01',
        '1.2.3-rc.01',
        '1.2.3-rc..1',
        '1.2.3-rc_1',
        '1.2.3+build..1',
        '1.2.3+build_1',
        'v1.2.3',
        'V1.2.3',
        '=1.2.3',
        ' 1.2.3',
        '1.2.3\n',
    ])('rejects noncanonical input without coercion: %j', (version) => {
        expect(parseVersion(version)).toBeNull();
    });
});

describe('compareVersions', () => {
    it.each([
        ['1.2.3', '1.2.3', 0],
        ['1.2.4', '1.2.3', 1],
        ['1.2.3', '1.2.4', -1],
        ['1.10.0', '1.9.0', 1],
        ['2.0.0', '1.9.9', 1],
        ['3.0.0', '1.0.0', 1],
        ['1.0.0', '3.0.0', -1],
        ['1.2.3', '1.2.3-rc.1', 1],
        ['1.2.3-rc.1', '1.2.3', -1],
        ['1.2.3-rc.1', '1.2.3-rc.1', 0],
        ['1.2.3-rc.1', '1.2.3-rc.2', -1],
        ['1.2.3-rc.2', '1.2.3-rc.1', 1],
        ['1.2.3-rc.10', '1.2.3-rc.2', 1],
        ['1.2.3-rc.1+build.2', '1.2.3-rc.1+build.1', 0],
        ['1.2.3-alpha-beta', '1.2.3-alpha', 1],
        ['2.0.0-rc.1', '1.9.9', 1],
    ] as const)('compareVersions(%j, %j) === %s', (a, b, expected) => {
        expect(compareVersions(a, b)).toBe(expected);
    });

    it.each(['1.2', '1.2.3.9', '1.2.x', '', 'v1.2.3', 'V1.2.3', '01.2.3', '1.2.3-rc.01'])(
        'rejects invalid versions instead of guessing: %j',
        (version) => {
            expect(() => compareVersions(version, '1.2.3')).toThrow();
            expect(() => compareVersions('1.2.3', version)).toThrow();
        },
    );
});
