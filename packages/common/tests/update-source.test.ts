import { describe, expect, it } from 'vitest';
import { normalizeMirrorUrl, normalizeUpdateSourceConfig } from '../src/update-source';
import { normalizeRuntimeConfig } from '../src/runtime';

describe('update source configuration', () => {
    it('normalizes proxy prefixes, deduplicates mirrors and retains order', () => {
        expect(
            normalizeUpdateSourceConfig({
                mode: 'auto',
                mirror: '',
                mirrors: [
                    ' https://EXAMPLE.com/proxy/ ',
                    'https://example.com/proxy',
                    'https://other.example',
                ],
            }),
        ).toEqual({
            mode: 'auto',
            mirror: '',
            mirrors: ['https://example.com/proxy', 'https://other.example'],
        });
    });

    it.each([
        '',
        'file:///tmp/x',
        'ftp://example.com',
        'https://user:secret@example.com',
        'https://example.com/?token=a',
        'https://example.com/#a',
        null,
    ])('rejects invalid mirror %s', (url) => {
        expect(() => normalizeMirrorUrl(url)).toThrow();
    });

    it.each([
        null,
        [],
        { mode: ['auto'], mirrors: [] },
        { mode: 'mirror', mirror: '', mirrors: [] },
        { mode: 'auto', mirrors: Array(17).fill('https://example.com') },
    ])('rejects invalid configuration %j', (config) => {
        expect(() => normalizeUpdateSourceConfig(config)).toThrow();
    });

    it('retains configured update sources when normalizing runtime settings', () => {
        const updateSource = { mode: 'direct', mirror: '', mirrors: [] };
        expect(normalizeRuntimeConfig({ updateSource, webuiPort: 7777 })).toMatchObject({
            updateSource,
            webuiPort: 7777,
        });
        expect(normalizeRuntimeConfig({})).not.toHaveProperty('updateSource');
    });
});
