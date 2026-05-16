// Shared private helpers for the action modules. None of this is part
// of the public Bridge API; keeping it here avoids re-importing the
// same five-line utility from every themed file.

import type { Bridge } from '../bridge';

/**
 * Coerce numbers, strings, and bigints to a plain integer.
 * Returns 0 for anything we can't interpret — every action that
 * threads this through OIDB has an explicit `<=0` validation later.
 */
export function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  if (typeof value === 'string' && value.trim()) {
    const n = Number(value);
    return Number.isFinite(n) ? Math.trunc(n) : 0;
  }
  return 0;
}

/**
 * Standard OIDB response check: throw a typed Error if retCode != 0.
 * Prefers `wording` over `msg` for the human-facing message, falling
 * back to a generic string. All themed action modules use this for
 * their OIDB error-path uniformity.
 */
export function ensureRetCodeZero(operation: string, code: unknown, msg: unknown, wording: unknown): void {
  const retCode = toInt(code);
  if (retCode === 0) return;
  const text = (typeof wording === 'string' && wording) || (typeof msg === 'string' && msg) || 'unknown error';
  throw new Error(`${operation} failed: code=${retCode} msg=${text}`);
}

/**
 * Look up the bot's own UID. Cached on Identity once warmup populates
 * `selfProfile`; forward/profile actions need this fast path before
 * warmup completes.
 */
export async function resolveSelfUid(bridge: Bridge): Promise<string> {
  let selfUid = bridge.identity.selfUid;
  if (selfUid) return selfUid;

  const selfUin = toInt(bridge.identity.uin);
  if (selfUin <= 0) {
    throw new Error('self uid is unavailable');
  }
  selfUid = await bridge.resolveUserUid(selfUin);
  return selfUid;
}

/**
 * Index describing a server-side rich-media object (image / video /
 * voice). Returned by message parsers, consumed by the media-URL
 * fetchers in group-file.ts.
 */
export interface MediaIndexNode {
  info?: {
    fileSize?: number;
    fileHash?: string;
    fileSha1?: string;
    fileName?: string;
    width?: number;
    height?: number;
    time?: number;
    original?: number;
    type?: {
      type?: number;
      picFormat?: number;
      videoFormat?: number;
      voiceFormat?: number;
    };
  };
  fileUuid?: string;
  storeId?: number;
  uploadTime?: number;
  ttl?: number;
  subType?: number;
}
