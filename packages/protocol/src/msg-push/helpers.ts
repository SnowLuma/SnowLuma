import { protobuf_decode } from '@snowluma/proton';
import { hexPreview } from '@snowluma/common/hex';
import { inflateSync } from 'zlib';
import type { IdentityService } from '../identity-service';
import type { OperatorInfo } from '@snowluma/proto-defs/notify';

export const MAX_RICH_CARD_OUTPUT_BYTES = 4 * 1024 * 1024;
export const MAX_RICH_CARD_MESSAGE_OUTPUT_BYTES = 8 * 1024 * 1024;

export type DecompressDataResult =
  | { ok: true; text: string; outputBytes: number }
  | { ok: false; reason: string };

export function makeImageUrl(origUrl: string): string {
  if (!origUrl) return '';
  if (origUrl.includes('rkey')) return 'https://multimedia.nt.qq.com.cn' + origUrl;
  return 'http://gchat.qpic.cn' + origUrl;
}

export function decompressData(
  data: Uint8Array,
  maxOutputBytes = MAX_RICH_CARD_OUTPUT_BYTES,
): DecompressDataResult {
  if (!data || data.length === 0) return { ok: false, reason: 'empty_payload' };
  if (!Number.isSafeInteger(maxOutputBytes) || maxOutputBytes <= 0) {
    throw new Error(`invalid decompression output limit: ${maxOutputBytes}`);
  }
  if ((data[0] === 0x00 || data[0] === 0x01) && data.length === 1) {
    return { ok: false, reason: 'marker_without_payload' };
  }
  if (data[0] === 0x01) {
    try {
      const inflated = inflateSync(Buffer.from(data.subarray(1)), {
        maxOutputLength: maxOutputBytes,
      });
      return inflated.length > 0
        ? { ok: true, text: inflated.toString('utf8'), outputBytes: inflated.length }
        : { ok: false, reason: 'empty_output' };
    } catch (error) {
      const code = typeof error === 'object' && error !== null && 'code' in error
        ? String(error.code)
        : '';
      return {
        ok: false,
        reason: code === 'ERR_BUFFER_TOO_LARGE'
          ? 'output_limit_exceeded'
          : code
            ? `inflate_failed:${code}`
            : 'inflate_failed',
      };
    }
  }
  if (data[0] === 0x00) {
    if (data.length - 1 > maxOutputBytes) return { ok: false, reason: 'output_limit_exceeded' };
    return {
      ok: true,
      text: Buffer.from(data.subarray(1)).toString('utf8'),
      outputBytes: data.length - 1,
    };
  }
  if (data.length > maxOutputBytes) return { ok: false, reason: 'output_limit_exceeded' };
  return { ok: true, text: Buffer.from(data).toString('utf8'), outputBytes: data.length };
}

export function isNumericUin(value: string): boolean {
  return value.length > 0 && /^\d+$/.test(value);
}

export function parseU64OrZero(value: string): number {
  if (!value) return 0;
  const n = parseInt(value, 10);
  return isNaN(n) ? 0 : n;
}

// Cascades group-scoped lookup → in-memory map → SQLite.
// No network fallback on the parse hot path: missing identities fall back to
// `fallback` and downstream events drive a roster refresh asynchronously.
export function resolveUidToUin(identity: IdentityService, groupId: number, uid: string, fallback = 0): number {
  if (!uid) return fallback;
  if (isNumericUin(uid)) {
    const n = parseInt(uid, 10);
    if (!isNaN(n)) return n;
  }
  const uin = identity.findUinByUid(uid, groupId || undefined);
  if (uin !== null) return uin;
  return fallback;
}

const OPERATOR_BYTES_PREVIEW_LENGTH = 32;

function describeOperatorBytes(bytes: Uint8Array): string {
  return `bytes=${bytes.length} preview=${hexPreview(bytes, OPERATOR_BYTES_PREVIEW_LENGTH)}`;
}

function hasControlCharacter(value: string): boolean {
  for (const char of value) {
    const codePoint = char.codePointAt(0);
    if (codePoint !== undefined && (codePoint <= 0x1f || codePoint === 0x7f)) return true;
  }
  return false;
}

function assertOperatorUid(uid: string, context: string, bytes: Uint8Array): string {
  if (hasControlCharacter(uid)) {
    throw new Error(`${context} operator UID contains control characters (${describeOperatorBytes(bytes)})`);
  }
  return uid;
}

export function decodeRawOperatorUid(bytes: Uint8Array, context: string): string {
  if (!bytes || bytes.length === 0) return '';
  let uid: string;
  try {
    uid = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch (error) {
    throw new Error(
      `${context} operator UID is not valid UTF-8 (${describeOperatorBytes(bytes)})`,
      { cause: error },
    );
  }
  return assertOperatorUid(uid, context, bytes);
}

export function decodeNestedOperatorUid(bytes: Uint8Array, context: string): string {
  if (!bytes || bytes.length === 0) return '';
  let info: OperatorInfo | null;
  try {
    info = protobuf_decode<OperatorInfo>(bytes);
  } catch (error) {
    throw new Error(
      `${context} operator info decode failed (${describeOperatorBytes(bytes)})`,
      { cause: error },
    );
  }
  const uid = info?.operatorField?.uid;
  if (!uid) {
    throw new Error(`${context} operator info is missing UID (${describeOperatorBytes(bytes)})`);
  }
  return assertOperatorUid(uid, context, bytes);
}

const OPERATOR_INFO_FIELD_TAG = 0x0a;

export function decodeGroupChangeOperatorUid(bytes: Uint8Array, context: string): string {
  if (!bytes || bytes.length === 0) return '';
  return bytes[0] === OPERATOR_INFO_FIELD_TAG
    ? decodeNestedOperatorUid(bytes, context)
    : decodeRawOperatorUid(bytes, context);
}

export function buildTemplateMap(params: Array<{ name?: string; value?: string }>): Map<string, string> {
  const map = new Map<string, string>();
  for (const p of params) {
    if (p.name !== undefined) map.set(p.name, p.value ?? '');
  }
  return map;
}

export function findTemplateValue(map: Map<string, string>, ...keys: string[]): string {
  for (const k of keys) {
    const v = map.get(k);
    if (v) return v;
  }
  return '';
}

export function unwrapGroupNotifyPayload(content: Uint8Array): Uint8Array | null {
  if (content.length <= 7) return null;
  const lenBe = (content[5] << 8) | content[6];
  const lenLe = content[5] | (content[6] << 8);
  if (7 + lenBe <= content.length) return content.subarray(7, 7 + lenBe);
  if (7 + lenLe <= content.length) return content.subarray(7, 7 + lenLe);
  return content.subarray(7);
}
