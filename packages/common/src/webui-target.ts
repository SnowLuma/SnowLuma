/** Browser-safe contract shared by startup, the WebUI and embedding hosts.
 * Targets are deployment choices; they never belong in the saved UI preferences. */
export const WEBUI_TARGETS = {
    maibot: {
        label: '麦麦 / 一键包',
        styles: ['millennium'],
        defaultStyle: 'millennium',
    },
} as const;

export type WebuiTarget = keyof typeof WEBUI_TARGETS;
export type WebuiColorMode = 'light' | 'dark' | 'system';

export type WebuiPresentation = {
    [T in WebuiTarget]: {
        version: 1;
        target: T;
        style: (typeof WEBUI_TARGETS)[T]['styles'][number];
        mode: WebuiColorMode;
    };
}[WebuiTarget];

/** null releases the override for this document, without changing deployment opt-in. */
export type WebuiPresentationUpdate = WebuiPresentation | { version: 1; target: null };
export const WEBUI_PRESENTATION_EVENT = 'snowluma:host-appearance';
export const WEBUI_TARGET_BOOTSTRAP_ID = 'snowluma-webui-target';

export function resolveWebuiTarget(raw: string | undefined): WebuiTarget | null {
    if (raw === undefined || raw.trim() === '') {
        return null;
    }

    const value = raw.trim();

    if (!Object.hasOwn(WEBUI_TARGETS, value)) {
        throw new Error(
            `Invalid SNOWLUMA_WEBUI_TARGET: ${JSON.stringify(value)}. Expected ${Object.keys(WEBUI_TARGETS).join(', ')} or an empty value.`,
        );
    }

    return value as WebuiTarget;
}

export function defaultWebuiPresentation(target: WebuiTarget): WebuiPresentation {
    return { version: 1, target, style: WEBUI_TARGETS[target].defaultStyle, mode: 'system' };
}

export function parseWebuiPresentation(value: unknown): WebuiPresentationUpdate {
    if (
        !value ||
        typeof value !== 'object' ||
        !('version' in value) ||
        value.version !== 1 ||
        !('target' in value)
    ) {
        throw new TypeError('Invalid host appearance: expected a version 1 presentation');
    }

    if (value.target === null) {
        return { version: 1, target: null };
    }

    if (typeof value.target !== 'string' || !Object.hasOwn(WEBUI_TARGETS, value.target)) {
        throw new TypeError('Invalid host appearance target');
    }

    const target = value.target as WebuiTarget;
    const styles: readonly string[] = WEBUI_TARGETS[target].styles;

    if (!('style' in value) || typeof value.style !== 'string' || !styles.includes(value.style)) {
        throw new TypeError(`Invalid host appearance style for ${target}`);
    }

    if (
        !('mode' in value) ||
        (value.mode !== 'light' && value.mode !== 'dark' && value.mode !== 'system')
    ) {
        throw new TypeError('Invalid host appearance color mode');
    }

    // Both discriminants have been checked against the same target registry.
    return { version: 1, target, style: value.style, mode: value.mode } as WebuiPresentation;
}

/** Inject before the cached pre-paint theme script. Default HTML stays byte-for-byte intact. */
export function injectWebuiTarget(html: string, target: WebuiTarget | null): string {
    if (target === null) {
        return html;
    }

    if (!html.includes('<head>')) {
        throw new Error('WebUI HTML is missing <head>; cannot inject runtime target');
    }

    const json = JSON.stringify(defaultWebuiPresentation(target)).replaceAll('<', '\\u003c');
    return html.replace(
        '<head>',
        `<head>\n    <script id="${WEBUI_TARGET_BOOTSTRAP_ID}" type="application/json">${json}</script>`,
    );
}
