import type { WebuiPresentation, WebuiTarget } from '@snowluma/common/webui-target';
import type { UiAppearance } from '@/types';

export interface TargetAppearance {
    css: string;
    licenseUrl?: string;
    resolve: (saved: UiAppearance, presentation: WebuiPresentation) => UiAppearance;
}

export function resolveAppearance(
    saved: UiAppearance,
    presentation: WebuiPresentation | null,
    target: TargetAppearance | null,
): UiAppearance {
    if (!presentation) {
        return saved;
    }

    if (!target) {
        throw new Error('Target appearance must be prepared before mounting ThemeProvider');
    }

    return target.resolve(saved, presentation);
}

// Exhaustive: adding a shared target requires a frontend implementation here.
export const targetLoaders = {
    maibot: () => import('./targets/maibot').then((module) => module.maibotAppearance),
} satisfies Record<WebuiTarget, () => Promise<TargetAppearance>>;
