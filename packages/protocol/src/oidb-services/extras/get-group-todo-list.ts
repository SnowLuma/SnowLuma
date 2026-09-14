// 0x9474_0 — query the group's current todo banners.
//
// Current QQ exposes this as a packet-backed query. Request flag 1 selects
// todos. Each active banner identifies its source message twice: msgId carries
// `sequence_random`, while commonBanner.jumpInfo.jumpParam carries JSON with
// the same pair. Both sources are checked when present so a malformed identity
// can never poison SnowLuma's message-id cache.

import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbOnlineBanner,
  OidbQueryGroupTopBannersReq,
  OidbQueryGroupTopBannersResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface GroupTodoListItem {
  sourceId: string;
  sequence: number;
  random: number;
  text: string;
  createdAt: number;
  updatedAt: number;
}

interface MessageIdentity {
  sequence: number;
  random: number;
}

const TODO_BANNER_FLAG = 1;
const SOURCE_ID_PATTERN = /^([1-9]\d*)_(-?\d+)$/;
const utf8 = new TextDecoder('utf-8', { fatal: true });

function decodeUtf8(bytes: Uint8Array, description: string): string {
  try {
    return utf8.decode(bytes);
  } catch {
    throw new Error(`invalid group todo ${description}`);
  }
}

function parseSafeInteger(value: unknown, description: string): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value)) {
    throw new Error(`invalid group todo ${description}`);
  }
  return value;
}

function parseSourceIdentity(bytes: Uint8Array | undefined): MessageIdentity & { sourceId: string } {
  if (!bytes || bytes.length === 0) {
    throw new Error('invalid group todo message identity');
  }
  const sourceId = decodeUtf8(bytes, 'message identity');
  const match = SOURCE_ID_PATTERN.exec(sourceId);
  if (!match) throw new Error('invalid group todo message identity');

  const sequence = Number(match[1]);
  const random = Number(match[2]);
  if (!Number.isSafeInteger(sequence) || sequence <= 0 || !Number.isSafeInteger(random)) {
    throw new Error('invalid group todo message identity');
  }
  return { sourceId, sequence, random };
}

function parseJumpIdentity(bytes: Uint8Array | undefined): MessageIdentity | null {
  if (!bytes || bytes.length === 0) return null;

  let decoded: unknown;
  try {
    decoded = JSON.parse(decodeUtf8(bytes, 'jump identity'));
  } catch (error) {
    if (error instanceof Error && error.message.startsWith('invalid group todo')) throw error;
    throw new Error('invalid group todo jump identity');
  }
  if (!decoded || typeof decoded !== 'object' || Array.isArray(decoded)) {
    throw new Error('invalid group todo jump identity');
  }

  const record = decoded as Record<string, unknown>;
  const sequence = parseSafeInteger(record.seq, 'jump identity');
  const random = parseSafeInteger(record.random, 'jump identity');
  if (sequence <= 0) throw new Error('invalid group todo jump identity');
  return { sequence, random };
}

function parseTimestamp(value: bigint | number | null | undefined, description: string): number {
  if (value === undefined || value === null) return 0;
  const timestamp = typeof value === 'bigint' ? Number(value) : value;
  if (!Number.isSafeInteger(timestamp) || timestamp < 0) {
    throw new Error(`invalid group todo ${description}`);
  }
  return timestamp;
}

function parseBanner(banner: OidbOnlineBanner): GroupTodoListItem {
  const source = parseSourceIdentity(banner.msgId);
  const jump = parseJumpIdentity(banner.commonBanner?.jumpInfo?.jumpParam);
  if (jump && (jump.sequence !== source.sequence || jump.random !== source.random)) {
    throw new Error('group todo message identity mismatch');
  }

  return {
    sourceId: source.sourceId,
    sequence: source.sequence,
    random: source.random,
    text: banner.commonBanner?.ui?.text ?? banner.todoBanner?.text ?? '',
    createdAt: parseTimestamp(banner.commonBanner?.createTime, 'create time'),
    updatedAt: parseTimestamp(banner.commonBanner?.updateTime, 'update time'),
  };
}

export namespace GetGroupTodoList {
  export const command = 0x9474;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbQueryGroupTopBannersReq => {
    if (!Number.isSafeInteger(p.groupId) || p.groupId <= 0) {
      throw new Error('invalid group id');
    }
    return {
      groupId: BigInt(p.groupId),
      bannerFlag: TODO_BANNER_FLAG,
    };
  };

  export const deserialize = (
    _ctx: Deps,
    body: OidbQueryGroupTopBannersResp,
  ): GroupTodoListItem[] => (body.banners ?? [])
    .filter((banner) => banner.isDisappear !== true)
    .map(parseBanner);

  export const encode = (env: OidbBase<OidbQueryGroupTopBannersReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbQueryGroupTopBannersReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbQueryGroupTopBannersResp> =>
    protobuf_decode<OidbBase<OidbQueryGroupTopBannersResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<GroupTodoListItem[]> =>
    invokeOidb(deps, GetGroupTodoList, params);
}
