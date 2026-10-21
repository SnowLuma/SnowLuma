import { describe, expect, it, vi } from 'vitest';
import { defaultWebuiPresentation, WEBUI_PRESENTATION_EVENT } from '@snowluma/common/webui-target';
import { createPresentationStore } from '../src/appearance/store';
import { subscribeHostAppearance } from '../src/appearance/runtime';
import { resolveAppearance } from '../src/appearance/registry';
import { maibotAppearance } from '../src/appearance/targets/maibot';
import { DEFAULT_APPEARANCE } from '../src/contexts/ThemeContext';

const initial = defaultWebuiPresentation('maibot');

describe('reversible presentation overlay', () => {
    it('retains saved appearance, wallpaper, custom CSS and accessibility preferences', () => {
        const saved = structuredClone(DEFAULT_APPEARANCE);
        Object.assign(saved, {
            customCss: 'body { color: red; }',
            palette: 'catppuccin-mocha',
            radius: 1,
            fontSansCustom: 'My Font',
            customPointerSystem: true,
            reduceMotion: true,
            disableMotion: true,
            highContrast: true,
            uiScale: 1.2,
        });
        saved.background.type = 'image';
        saved.background.hasImage = true;
        const before = structuredClone(saved);

        const effective = resolveAppearance(saved, { ...initial, mode: 'light' }, maibotAppearance);
        expect(effective).toMatchObject({
            mode: 'light',
            palette: 'default',
            radius: 0,
            customCss: '',
            background: { type: 'none' },
            customPointerSystem: false,
            reduceMotion: true,
            disableMotion: true,
            highContrast: true,
            uiScale: 1.2,
        });
        expect(saved).toEqual(before);
        expect(resolveAppearance(saved, null, maibotAppearance)).toBe(saved);
        expect(resolveAppearance(saved, null, null)).toBe(saved);
    });

    it('cannot enable a target through host messages on a standalone deployment', () => {
        const store = createPresentationStore(null);
        const host = new EventTarget() as Window;
        const add = vi.spyOn(host, 'addEventListener');
        const cleanup = subscribeHostAppearance(host, store);
        store.receive(initial);
        expect(store.getSnapshot()).toBeNull();
        expect(add).not.toHaveBeenCalled();
        cleanup();
    });

    it('applies the latest of rapid updates synchronously, deduplicates, releases and restores', () => {
        const store = createPresentationStore('maibot');
        const notify = vi.fn();
        const cleanup = store.subscribe(notify);
        store.receive(initial);
        expect(notify).not.toHaveBeenCalled();
        store.receive({ ...initial, mode: 'dark' });
        store.receive({ ...initial, mode: 'light' });
        expect(store.getSnapshot()?.mode).toBe('light');
        store.receive({ version: 1, target: null });
        expect(store.getSnapshot()).toBeNull();
        store.receive(initial);
        expect(store.getSnapshot()).toEqual(initial);
        cleanup();
        store.receive({ ...initial, mode: 'dark' });
        expect(notify).toHaveBeenCalledTimes(4);
    });

    it('reads pre-mount host state, reports invalid input and cleans up subscriptions', () => {
        const store = createPresentationStore('maibot');
        const host = new EventTarget() as Window;
        host.__SNOWLUMA_HOST_APPEARANCE__ = { ...initial, mode: 'dark' };
        const error = vi.spyOn(console, 'error').mockImplementation(() => {});
        const cleanup = subscribeHostAppearance(host, store);

        try {
            expect(store.getSnapshot()?.mode).toBe('dark');
            host.dispatchEvent(
                new CustomEvent(WEBUI_PRESENTATION_EVENT, {
                    detail: { ...initial, mode: 'invalid' },
                }),
            );
            expect(error).toHaveBeenCalledOnce();
            expect(store.getSnapshot()?.mode).toBe('dark');
            host.dispatchEvent(
                new CustomEvent(WEBUI_PRESENTATION_EVENT, {
                    detail: { ...initial, mode: 'light' },
                }),
            );
            expect(store.getSnapshot()?.mode).toBe('light');
            cleanup();
            host.dispatchEvent(new CustomEvent(WEBUI_PRESENTATION_EVENT, { detail: initial }));
            expect(store.getSnapshot()?.mode).toBe('light');
        } finally {
            cleanup();
            error.mockRestore();
        }
    });
});
