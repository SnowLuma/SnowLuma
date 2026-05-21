import type { HookProcessBaseInfo } from './injector';

export type HookProcessStatus =
  | 'available'
  | 'loading'
  | 'connecting'
  | 'loaded'
  | 'online'
  | 'error'
  | 'disconnected';

/** Public-facing snapshot of a per-PID HookSession. */
export interface HookProcessInfo extends HookProcessBaseInfo {
  injected: boolean;
  connected: boolean;
  loggedIn: boolean;
  uin: string;
  status: HookProcessStatus;
  error: string;
  method: string;
}
