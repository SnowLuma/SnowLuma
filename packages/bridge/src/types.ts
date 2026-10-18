import type { HookProcessBaseInfo } from './injector';

export type HookProcessStatus =
    'available' | 'loading' | 'connecting' | 'loaded' | 'online' | 'error' | 'disconnected';

/** Account the QQ client is signed in as, as reported by its local data. */
export interface HookProcessAccount {
    uin: string;
    nickname: string;
}

/** Public-facing snapshot of a per-PID HookSession. */
export interface HookProcessInfo extends HookProcessBaseInfo {
    injected: boolean;
    connected: boolean;
    loggedIn: boolean;
    uin: string;
    status: HookProcessStatus;
    error: string;
    method: string;
    /** Locally detected identity; null means unknown, not necessarily signed out. */
    account: HookProcessAccount | null;
}
