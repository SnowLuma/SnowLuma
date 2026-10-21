import { createRequire } from 'node:module';
import { readFileSync, readdirSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { SUPPORTED_NODE_RANGE, isSupportedNodeVersion } =
    require('../../runtime/check-node-version.cjs') as {
        SUPPORTED_NODE_RANGE: string;
        isSupportedNodeVersion: (version: string) => boolean;
    };

describe('runtime Node.js preflight', () => {
    it.each(['24.22.1', '24.22.2', '24.23.0', '24.22.1+vendor.1', '26.12.1', '26.13.0', '27.0.0'])(
        'accepts patched stable Node.js %s',
        (version) => {
            expect(isSupportedNodeVersion(version)).toBe(true);
        },
    );

    it.each([
        '22.23.4',
        '23.99.99',
        '24.0.0',
        '24.21.0',
        '24.22.0',
        '25.99.99',
        '26.0.0',
        '26.11.99',
        '26.12.0',
        '24.22.1-rc.1',
        '26.12.1-rc.1',
        'not-a-version',
    ])('rejects unpatched, unsupported or malformed Node.js %s', (version) => {
        expect(isSupportedNodeVersion(version)).toBe(false);
    });

    it('keeps workspace requirements and the bundled runtime baseline aligned', () => {
        expect(SUPPORTED_NODE_RANGE).toBe('^24.22.1 || >=26.12.1');
        const root = new URL('../../../', import.meta.url);
        const packages = readdirSync(new URL('packages/', root), { withFileTypes: true });
        const manifests = [
            new URL('package.json', root),
            ...packages
                .filter((entry) => entry.isDirectory())
                .map((entry) => new URL(`packages/${entry.name}/package.json`, root)),
        ];

        for (const manifest of manifests) {
            const pkg = JSON.parse(readFileSync(manifest, 'utf8'));
            expect(pkg.engines.node, manifest.pathname).toBe(SUPPORTED_NODE_RANGE);
        }

        const baseline = readFileSync(new URL('.node-version', root), 'utf8').trim();
        expect(baseline).toBe('24.22.1');
        expect(isSupportedNodeVersion(baseline)).toBe(true);
    });
});
