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

// The bot's-own-UID resolver is the single source of truth in @snowluma/protocol
// (a Bridge satisfies its BridgeContext slice). Re-exported here so the existing
// `resolveSelfUid(bridge)` call sites in this package keep importing from shared.
export { resolveSelfUid } from '@snowluma/protocol/self-uid';

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
