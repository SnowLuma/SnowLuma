import {
    parseWebuiPresentation,
    WEBUI_PRESENTATION_EVENT,
    WEBUI_TARGET_BOOTSTRAP_ID,
    type WebuiPresentation,
} from '@snowluma/common/webui-target';
import { createPresentationStore, type PresentationStore } from './store';
import { targetLoaders, type TargetAppearance } from './registry';

declare global {
    interface Window {
        /** The embedding host sets this before dispatching WEBUI_PRESENTATION_EVENT. */
        __SNOWLUMA_HOST_APPEARANCE__?: unknown;
    }
}

const bootstrap =
    typeof document === 'undefined' ? null : document.getElementById(WEBUI_TARGET_BOOTSTRAP_ID);
const initial = bootstrap
    ? parseWebuiPresentation(JSON.parse(bootstrap.textContent || 'null'))
    : null;
export const presentationStore = createPresentationStore(initial?.target ?? null);
let targetAppearance: TargetAppearance | null = null;

function acceptHostValue(store: PresentationStore, value: unknown): void {
    try {
        store.receive(value);
    } catch (error) {
        // Reject only the bad update; keep the last valid presentation and expose the failure.
        console.error('[SnowLuma appearance] Rejected host update', error);
    }
}

export function subscribeHostAppearance(host: Window, store: PresentationStore): () => void {
    if (store.target === null) {
        return () => {};
    }

    const receive = (event: Event) =>
        acceptHostValue(store, (event as CustomEvent<unknown>).detail);
    host.addEventListener(WEBUI_PRESENTATION_EVENT, receive);

    // Covers messages sent before React subscribed, including while the lazy CSS was loading.
    if (host.__SNOWLUMA_HOST_APPEARANCE__ !== undefined) {
        acceptHostValue(store, host.__SNOWLUMA_HOST_APPEARANCE__);
    }

    return () => host.removeEventListener(WEBUI_PRESENTATION_EVENT, receive);
}

export function applyPresentationAttributes(presentation: WebuiPresentation | null): void {
    const root = document.documentElement;

    if (presentation) {
        root.dataset.webuiTarget = presentation.target;
        root.dataset.webuiStyle = presentation.style;
    } else {
        delete root.dataset.webuiTarget;
        delete root.dataset.webuiStyle;
    }
}

export function getTargetAppearance(): TargetAppearance | null {
    return targetAppearance;
}

/** Called before mounting React; standalone deployments do not load any target assets. */
export async function prepareTargetAppearance(): Promise<void> {
    const target = presentationStore.target;

    if (target === null) {
        return;
    }

    targetAppearance = await targetLoaders[target]();
    const style = document.createElement('style');
    style.id = 'snowluma-target-styles';
    style.textContent = targetAppearance.css;
    document.head.appendChild(style);

    if (targetAppearance.licenseUrl) {
        const license = document.createElement('link');
        license.rel = 'license';
        license.href = targetAppearance.licenseUrl;
        document.head.appendChild(license);
    }

    if (window.__SNOWLUMA_HOST_APPEARANCE__ !== undefined) {
        acceptHostValue(presentationStore, window.__SNOWLUMA_HOST_APPEARANCE__);
    }

    const presentation = presentationStore.getSnapshot();
    applyPresentationAttributes(presentation);

    if (presentation) {
        const dark =
            presentation.mode === 'system'
                ? window.matchMedia('(prefers-color-scheme: dark)').matches
                : presentation.mode === 'dark';
        document.documentElement.classList.toggle('dark', dark);
        document.documentElement.classList.toggle('light', !dark);
        document.documentElement.style.colorScheme = dark ? 'dark' : 'light';
    }
}
