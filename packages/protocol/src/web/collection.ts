import type { JsonObject, JsonValue } from '@snowluma/common/json';
import type {
  CollectionItem as CollectionItemWire,
  CollectionRequestBody,
  CollectionRequestHead,
  CollectionResponseBody,
  CollectionResponseHead,
  GetCollectionListRequest,
} from '@snowluma/proto-defs/collection';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';

const COLLECTION_ENDPOINT = 'https://collector.weiyun.com/collector.fcg';
const COLLECTION_HOST = 'collector.weiyun.com';
const COLLECTION_OPERATION_ID = 20_000;
const COLLECTION_TICKET_TYPE = 27;
const COLLECTION_APP_ID = 5_004;
const COLLECTION_PAGE_SIZE = 50;
const COLLECTION_MAX_COUNT = 500;
const COLLECTION_MAX_PAGES = 100;
const COLLECTION_TIMEOUT_MS = 10_000;
const COLLECTION_OPERATION_TIMEOUT_MS = 60_000;
const COLLECTION_RESPONSE_LIMIT = 16 * 1024 * 1024;
const INITIAL_TIMESTAMP = 0xFFFF_FFFF_FFFF_FFFFn;
const MAGIC = Uint8Array.from([0x20, 0x13, 0x03, 0x29]);
const VERSION = Uint8Array.from([0x00, 0x01]);

export interface CollectionHttpRequest {
  readonly url: string;
  readonly headers: Readonly<Record<string, string>>;
  readonly body: Uint8Array;
  readonly timeoutMs: number;
}

export type CollectionTransport = (request: CollectionHttpRequest) => Promise<Uint8Array>;

export interface GetCollectionListParams {
  readonly uin: string;
  readonly pskey: string;
  readonly category?: number;
  readonly count?: number;
  readonly transport?: CollectionTransport;
}

export interface CollectionAuthor extends JsonObject {
  type: number;
  numId: string;
  strId: string;
  groupId: string;
  groupName: string;
  uid: string;
}

export interface CollectionSummary extends JsonObject {
  textSummary: JsonValue;
  linkSummary: JsonValue;
  gallerySummary: JsonValue;
  audioSummary: JsonValue;
  videoSummary: JsonValue;
  fileSummary: JsonValue;
  locationSummary: JsonValue;
  richMediaSummary: JsonValue;
}

export interface CollectionItem extends JsonObject {
  cid: string;
  type: number;
  status: number;
  author: CollectionAuthor;
  bid: number;
  category: number;
  createTime: string;
  collectTime: string;
  modifyTime: string;
  sequence: string;
  shareUrl: string;
  customGroupId: number;
  securityBeat: boolean;
  summary: CollectionSummary;
}

export interface CollectionSearchList extends JsonObject {
  collectionItemList: CollectionItem[];
  hasMore: boolean;
  bottomTimeStamp: string;
}

export interface CollectionListResult extends JsonObject {
  errCode: 0;
  errMsg: string;
  collectionSearchList: CollectionSearchList;
}

function positiveUin(value: string): bigint {
  if (!/^[1-9]\d*$/.test(value)) throw new Error('collection uin must be a positive integer');
  const uin = BigInt(value);
  if (uin > INITIAL_TIMESTAMP) throw new Error('collection uin exceeds uint64 range');
  return uin;
}

function positiveCount(value: number): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > COLLECTION_MAX_COUNT) {
    throw new Error(`collection count must be between 1 and ${COLLECTION_MAX_COUNT}`);
  }
  return value;
}

function validCategory(value: number): number {
  if (!Number.isSafeInteger(value) || value < 0) {
    throw new Error('collection category must be a non-negative safe integer');
  }
  return value;
}

function encodeEnvelope(head: Uint8Array, body: Uint8Array): Uint8Array {
  const totalLength = 16 + head.length + body.length;
  const output = Buffer.allocUnsafe(totalLength);
  output.set(MAGIC, 0);
  output.set(VERSION, 4);
  output.writeUInt32BE(totalLength, 6);
  output.writeUInt32BE(body.length, 10);
  output.writeUInt16BE(0, 14);
  output.set(head, 16);
  output.set(body, 16 + head.length);
  return output;
}

function decodeEnvelope(bytes: Uint8Array): {
  head: CollectionResponseHead;
  body: CollectionResponseBody;
} {
  const input = Buffer.from(bytes);
  if (input.length <= 16) throw new Error('collection response is too short');
  if (!input.subarray(0, 4).equals(Buffer.from(MAGIC))) {
    throw new Error('collection response has invalid magic');
  }
  if (!input.subarray(4, 6).equals(Buffer.from(VERSION))) {
    throw new Error('collection response has unsupported version');
  }
  const totalLength = input.readUInt32BE(6);
  if (totalLength !== input.length) {
    throw new Error(`collection response length mismatch: ${totalLength} != ${input.length}`);
  }
  const bodyLength = input.readUInt32BE(10);
  if (input.readUInt16BE(14) !== 0) throw new Error('collection response has invalid reserved bytes');
  if (bodyLength === 0 || bodyLength >= totalLength - 16) {
    throw new Error('collection response has invalid body length');
  }
  const bodyOffset = totalLength - bodyLength;
  return {
    head: protobuf_decode<CollectionResponseHead>(input.subarray(16, bodyOffset)),
    body: protobuf_decode<CollectionResponseBody>(input.subarray(bodyOffset)),
  };
}

function jsonSafe(value: unknown): JsonValue {
  if (value === null || value === undefined) return null;
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('collection response contains a non-finite number');
    return value;
  }
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (value instanceof Uint8Array) return Buffer.from(value).toString('base64');
  if (Array.isArray(value)) return value.map(jsonSafe);
  if (typeof value === 'object') {
    const output: JsonObject = {};
    for (const [key, field] of Object.entries(value)) output[key] = jsonSafe(field);
    return output;
  }
  throw new Error(`collection response contains unsupported value type: ${typeof value}`);
}

function mapItem(item: CollectionItemWire): CollectionItem {
  const author = item.author ?? {};
  const summary = item.summary ?? {};
  const textSummary = summary.textSummary;
  const richMediaSummary = summary.richMediaSummary;
  return {
    cid: item.cid ?? '',
    type: item.type ?? 0,
    status: item.status ?? 0,
    author: {
      type: author.type ?? 0,
      numId: (author.numId ?? 0n).toString(),
      strId: author.strId ?? '',
      groupId: (author.groupId ?? 0n).toString(),
      groupName: author.groupName ?? '',
      uid: author.uid ?? '',
    },
    bid: item.bid ?? 0,
    category: item.category ?? 0,
    createTime: (item.createTime ?? 0n).toString(),
    collectTime: (item.collectTime ?? 0n).toString(),
    modifyTime: (item.modifyTime ?? 0n).toString(),
    sequence: (item.sequence ?? 0n).toString(),
    shareUrl: item.shareUrl ?? '',
    customGroupId: item.customGroupId ?? 0,
    securityBeat: item.securityBeat ?? false,
    summary: {
      textSummary: textSummary ? {
        text: textSummary.text ?? '',
        truncated: textSummary.truncated ?? false,
      } : null,
      linkSummary: jsonSafe(summary.linkSummary),
      gallerySummary: jsonSafe(summary.gallerySummary),
      audioSummary: jsonSafe(summary.audioSummary),
      videoSummary: jsonSafe(summary.videoSummary),
      fileSummary: jsonSafe(summary.fileSummary),
      locationSummary: jsonSafe(summary.locationSummary),
      richMediaSummary: richMediaSummary ? {
        title: richMediaSummary.title ?? '',
        subTitle: richMediaSummary.subTitle ?? '',
        brief: richMediaSummary.brief ?? '',
        picList: jsonSafe(richMediaSummary.picList ?? []),
        contentType: richMediaSummary.contentType ?? 0,
        originalUri: richMediaSummary.originalUri ?? '',
        publisher: richMediaSummary.publisher ?? '',
        richMediaVersion: richMediaSummary.richMediaVersion ?? 0,
      } : null,
    },
  };
}

function validateItem(item: CollectionItemWire): void {
  if (!item.cid) throw new Error('collection item is missing cid');
  if (!item.author) throw new Error(`collection item ${item.cid} is missing author`);
  if (item.modifyTime === null || item.modifyTime === undefined || item.modifyTime <= 0n) {
    throw new Error(`collection item ${item.cid} is missing modifyTime`);
  }
}

async function failAfterCleanup(
  primaryError: Error,
  cleanup?: () => Promise<void>,
): Promise<never> {
  if (cleanup) {
    try {
      await cleanup();
    } catch (cleanupError) {
      throw new AggregateError(
        [primaryError, cleanupError],
        `${primaryError.message}; response body cleanup also failed`,
      );
    }
  }
  throw primaryError;
}

async function defaultTransport(request: CollectionHttpRequest): Promise<Uint8Array> {
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), request.timeoutMs);
  try {
    const response = await fetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: Buffer.from(request.body),
      signal: controller.signal,
    });
    if (!response.ok) {
      const error = new Error(`collection HTTP request failed: ${response.status} ${response.statusText}`);
      await failAfterCleanup(
        error,
        response.body ? () => response.body!.cancel(error) : undefined,
      );
    }

    const declaredLength = response.headers.get('content-length');
    if (declaredLength !== null) {
      if (!/^\d+$/.test(declaredLength)) {
        const error = new Error('collection response has invalid content-length');
        await failAfterCleanup(
          error,
          response.body ? () => response.body!.cancel(error) : undefined,
        );
      }
      if (Number(declaredLength) > COLLECTION_RESPONSE_LIMIT) {
        const error = new Error(`collection response exceeds ${COLLECTION_RESPONSE_LIMIT} bytes`);
        await failAfterCleanup(
          error,
          response.body ? () => response.body!.cancel(error) : undefined,
        );
      }
    }
    if (!response.body) throw new Error('collection HTTP response has no body');

    const reader = response.body.getReader();
    const chunks: Uint8Array[] = [];
    let total = 0;
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        total += value.length;
        if (total > COLLECTION_RESPONSE_LIMIT) {
          const error = new Error(`collection response exceeds ${COLLECTION_RESPONSE_LIMIT} bytes`);
          await failAfterCleanup(error, () => reader.cancel(error));
        }
        chunks.push(value);
      }
    } finally {
      reader.releaseLock();
    }

    const output = Buffer.allocUnsafe(total);
    let offset = 0;
    for (const chunk of chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }
    return output;
  } catch (error) {
    if (error instanceof Error && error.name === 'AbortError') {
      throw new Error(`collection HTTP request timed out after ${request.timeoutMs}ms`, { cause: error });
    }
    throw error;
  } finally {
    clearTimeout(timeout);
  }
}

function requestBytes(uin: bigint, pskey: string, sequence: number, timeStamp: bigint): Uint8Array {
  const head = protobuf_encode<CollectionRequestHead>({
    uin,
    sequence,
    commandType: 1,
    operationId: COLLECTION_OPERATION_ID,
    clientVersion: 0x6105F5E164Fn,
    platform: 4,
    ticketType: COLLECTION_TICKET_TYPE,
    reserved: 0,
    ticket: pskey,
    field14: 8,
    field15: 9,
  });
  const request: GetCollectionListRequest = {
    field1: 0,
    field2: 0,
    field3: 0,
    timeStamp,
    orderType: 2,
    groupId: 0n,
    count: COLLECTION_PAGE_SIZE,
    searchDown: 1,
    field9: 0,
  };
  const body = protobuf_encode<CollectionRequestBody>({
    operation: { getCollectionList: request },
  });
  return encodeEnvelope(head, body);
}

export async function getCollectionList(params: GetCollectionListParams): Promise<CollectionListResult> {
  const uin = positiveUin(params.uin);
  if (params.pskey === '') throw new Error('collection p_skey is empty');
  const category = validCategory(params.category ?? 0);
  const count = positiveCount(params.count ?? COLLECTION_PAGE_SIZE);
  const targetMatchCount = category === 0 ? count : count + 1;
  const transport = params.transport ?? defaultTransport;
  const headers = {
    'Content-Type': 'application/octet-stream',
    Cookie: `uin=${params.uin};vt=${COLLECTION_TICKET_TYPE};vi=${params.pskey};appid=${COLLECTION_APP_ID}`,
    Host: COLLECTION_HOST,
    Range: 'bytes=0-',
  } as const;

  const matched: CollectionItem[] = [];
  const seen = new Set<string>();
  let sequence = 1;
  let timeStamp = INITIAL_TIMESTAMP;
  let serverHasMore = true;
  let errMsg = '';
  let pages = 0;
  const operationDeadline = Date.now() + COLLECTION_OPERATION_TIMEOUT_MS;

  while (matched.length < targetMatchCount && serverHasMore) {
    if (pages >= COLLECTION_MAX_PAGES) {
      throw new Error(`collection pagination exceeded ${COLLECTION_MAX_PAGES} pages`);
    }
    const remainingMs = operationDeadline - Date.now();
    if (remainingMs <= 0) {
      throw new Error(`collection pagination exceeded ${COLLECTION_OPERATION_TIMEOUT_MS}ms`);
    }
    pages += 1;
    const responseBytes = await transport({
      url: COLLECTION_ENDPOINT,
      headers,
      body: requestBytes(uin, params.pskey, sequence, timeStamp),
      timeoutMs: Math.min(COLLECTION_TIMEOUT_MS, remainingMs),
    });
    if (Date.now() >= operationDeadline) {
      throw new Error(`collection pagination exceeded ${COLLECTION_OPERATION_TIMEOUT_MS}ms`);
    }
    const response = decodeEnvelope(responseBytes);
    const retCode = response.head.retCode ?? 0;
    if (retCode !== 0) {
      const message = response.head.retMsg || response.head.promptMsg || 'unknown error';
      throw new Error(`collection service error ${retCode}: ${message}`);
    }
    errMsg = response.head.retMsg ?? '';

    const page = response.body.operation?.getCollectionList;
    if (!page) throw new Error('collection response is missing operation 20000');
    const wireItems = page.items ?? [];
    serverHasMore = (page.reachedBottom ?? 0) === 0;

    let nextTimeStamp: bigint | null = null;
    for (const wireItem of wireItems) {
      validateItem(wireItem);
      const modifyTime = wireItem.modifyTime ?? 0n;
      if (nextTimeStamp === null || modifyTime < nextTimeStamp) nextTimeStamp = modifyTime;

      const item = mapItem(wireItem);
      const identity = `cid:${item.cid}`;
      if (seen.has(identity)) continue;
      seen.add(identity);
      if (category === 0 || item.category === category) matched.push(item);
    }

    if (matched.length >= targetMatchCount || !serverHasMore) break;
    if (wireItems.length === 0 || nextTimeStamp === null || nextTimeStamp === 0n) {
      throw new Error('collection pagination made no progress while more data was reported');
    }
    if (nextTimeStamp >= timeStamp) {
      throw new Error(`collection pagination cursor did not decrease: ${nextTimeStamp}`);
    }
    timeStamp = nextTimeStamp;
    sequence += 1;
  }

  const collectionItemList = matched.slice(0, count);
  let publicBottomTimeStamp = 0n;
  for (const item of collectionItemList) {
    const itemTime = BigInt(item.modifyTime);
    if (publicBottomTimeStamp === 0n || itemTime < publicBottomTimeStamp) {
      publicBottomTimeStamp = itemTime;
    }
  }

  return {
    errCode: 0,
    errMsg,
    collectionSearchList: {
      collectionItemList,
      hasMore: category === 0 ? serverHasMore || matched.length > count : matched.length > count,
      bottomTimeStamp: publicBottomTimeStamp.toString(),
    },
  };
}
