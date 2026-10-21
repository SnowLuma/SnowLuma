import type { TargetAppearance } from '../registry';
import css from './maibot.css?inline';
import licenseUrl from './assets/Jersey20-OFL.txt?url';

export const maibotAppearance: TargetAppearance = {
    css,
    licenseUrl,
    resolve: (saved, presentation) => ({
        ...saved,
        mode: presentation.mode,
        palette: 'default',
        accentMode: 'preset',
        accentScope: 'global',
        darkIntensity: 'soft',
        sidebarStyle: 'follow',
        background: { ...saved.background, type: 'none' },
        fontSans: 'custom',
        fontSansCustom:
            '"SnowLuma Jersey 20", system-ui, "PingFang SC", "Microsoft YaHei", sans-serif',
        fontMono: 'default',
        fontMonoCustom: '',
        radius: 0,
        customCss: '',
        cssVars: {},
        customPointerSystem: false,
    }),
};
