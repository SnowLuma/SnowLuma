import { createRequire } from 'node:module';
import { describe, expect, it } from 'vitest';

const require = createRequire(import.meta.url);
const { SUPPORTED_NODE_RANGE, isSupportedNodeVersion } =
    require('../../runtime/check-node-version.cjs') as {
        SUPPORTED_NODE_RANGE: string;
        isSupportedNodeVersion: (version: string) => boolean;
    };

describe('runtime Node.js preflight', () => {
    it('accepts the documented minimum and newer versions', () => {
        expect(SUPPORTED_NODE_RANGE).toBe('>=24');
        expect(isSupportedNodeVersion('24.0.0')).toBe(true);
        expect(isSupportedNodeVersion('24.21.0')).toBe(true);
        expect(isSupportedNodeVersion('26.0.0')).toBe(true);
    });

    it('rejects older and malformed versions', () => {
        expect(isSupportedNodeVersion('22.99.99')).toBe(false);
        expect(isSupportedNodeVersion('23.99.99')).toBe(false);
        expect(isSupportedNodeVersion('21.99.99')).toBe(false);
        expect(isSupportedNodeVersion('not-a-version')).toBe(false);
    });
});
