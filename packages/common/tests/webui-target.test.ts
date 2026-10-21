import { describe, expect, it } from 'vitest';
import {
    defaultWebuiPresentation,
    injectWebuiTarget,
    parseWebuiPresentation,
    resolveWebuiTarget,
} from '../src/webui-target';

describe('deployment presentation contract', () => {
    it('requires explicit opt-in and rejects misspelled deployments', () => {
        expect(resolveWebuiTarget(undefined)).toBeNull();
        expect(resolveWebuiTarget('  ')).toBeNull();
        expect(resolveWebuiTarget('maibot')).toBe('maibot');
        expect(() => resolveWebuiTarget('mai-bot')).toThrow('SNOWLUMA_WEBUI_TARGET');
        expect(() => resolveWebuiTarget('__proto__')).toThrow('SNOWLUMA_WEBUI_TARGET');
    });

    it('keeps the unconfigured document intact and injects before cached appearance', () => {
        const html = '<html><head><script>readSavedAppearance()</script></head></html>';
        expect(injectWebuiTarget(html, null)).toBe(html);
        const injected = injectWebuiTarget(html, 'maibot');
        expect(injected.indexOf('snowluma-webui-target')).toBeLessThan(
            injected.indexOf('readSavedAppearance'),
        );
        expect(injected).toContain(JSON.stringify(defaultWebuiPresentation('maibot')));
        expect(() => injectWebuiTarget('broken html', 'maibot')).toThrow('missing <head>');
    });

    it('validates the version, target, style and color mode without accepting arbitrary CSS', () => {
        const valid = defaultWebuiPresentation('maibot');
        expect(parseWebuiPresentation(valid)).toEqual(valid);
        expect(
            parseWebuiPresentation({ ...valid, mode: 'dark', css: 'body{display:none}' }),
        ).toEqual({ ...valid, mode: 'dark' });
        expect(parseWebuiPresentation({ version: 1, target: null })).toEqual({
            version: 1,
            target: null,
        });

        for (const input of [
            null,
            {},
            { ...valid, version: 2 },
            { ...valid, target: 'other' },
            { ...valid, style: 'modern' },
            { ...valid, mode: 'blue' },
        ]) {
            expect(() => parseWebuiPresentation(input)).toThrow();
        }
    });
});
