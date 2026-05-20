import { protobuf_decode } from '@snowluma/proton';
import { inflateSync } from 'zlib';
import type { IdentityService } from '../identity-service';
import type { OperatorInfo } from '../proto/proton/notify';

export function makeImageUrl(origUrl: string): string {
  if (!origUrl) return '';
  if (origUrl.includes('rkey')) return 'https://multimedia.nt.qq.com.cn' + origUrl;
  return 'http://gchat.qpic.cn' + origUrl;
}

export function decompressData(data: Uint8Array): string {
  if (!data || data.length === 0) return '';
  if (data[0] === 0x01 && data.length > 1) {
    try {
      const inflated = inflateSync(Buffer.from(data.subarray(1)));
      return inflated.toString('utf8');
    } catch { return ''; }
  }
  if (data[0] === 0x00 && data.length > 1) {
    return Buffer.from(data.subarray(1)).toString('utf8');
  }
  return Buffer.from(data).toString('utf8');
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

export function decodeOperatorUid(bytes: Uint8Array): string {
  if (!bytes || bytes.length === 0) return '';
  const info = protobuf_decode<OperatorInfo>(bytes);
  if (info?.operatorField?.uid) return info.operatorField.uid;
  return Buffer.from(bytes).toString('utf8');
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
