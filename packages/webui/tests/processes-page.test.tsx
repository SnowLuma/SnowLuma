import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { ProcessesPage } from '../src/components/pages/processes-page';
import type { HookProcessInfo } from '../src/types';

const state = vi.hoisted(() => ({ processList: [] as HookProcessInfo[] }));

vi.mock('@/contexts/AppStateContext', () => ({
    useAppState: () => ({
        processList: state.processList,
        processOps: { statusOf: () => null, banner: null },
        refreshProcesses: vi.fn(),
        resources: { processList: { ready: true, error: '' } },
    }),
}));
vi.mock('@/contexts/LayoutContext', () => ({
    useLayout: () => ({ pages: { processesSort: 'pid' }, setPages: vi.fn() }),
}));
vi.mock('@/contexts/ThemeContext', () => ({
    useTheme: () => ({ appearance: { disableMotion: true } }),
}));
vi.mock('@/components/confirm-dialog', () => ({ ConfirmDialog: () => null }));

function renderProcess(overrides: Partial<HookProcessInfo>) {
    state.processList = [
        {
            pid: 4242,
            name: 'qq',
            path: '',
            injected: false,
            connected: false,
            loggedIn: false,
            uin: '0',
            status: 'available',
            error: '',
            method: '',
            account: null,
            ...overrides,
        },
    ];
    return renderToStaticMarkup(<ProcessesPage />);
}

describe('process account labels', () => {
    it('does not label an unidentified process as signed out', () => {
        const markup = renderProcess({});
        expect(markup).toContain('PID 4242');
        expect(markup).not.toContain('未登录');
        expect(markup).not.toContain('/avatar/');
    });

    it('shows the locally detected identity before hook login', () => {
        const markup = renderProcess({ account: { uin: '10001', nickname: 'Alice' } });
        expect(markup).toContain('Alice');
        expect(markup).toContain('/avatar/10001');
        expect(markup).toContain('QQ 10001');
    });

    it('uses native login identity without an account database', () => {
        const markup = renderProcess({ loggedIn: true, uin: '10002', status: 'online' });
        expect(markup).toContain('/avatar/10002');
        expect(markup).toContain('已在线');
    });

    it('does not apply a stale local nickname to a newly logged-in account', () => {
        const markup = renderProcess({
            loggedIn: true,
            uin: '10002',
            status: 'online',
            account: { uin: '10001', nickname: 'Alice' },
        });
        expect(markup).toContain('/avatar/10002');
        expect(markup).not.toContain('Alice');
        expect(markup).not.toContain('10001');
    });
});
