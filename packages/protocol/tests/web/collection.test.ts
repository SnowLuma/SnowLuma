import { afterEach, describe, expect, it, vi } from 'vitest';
import type { bool, int_32, pb, pb_repeated, uint_32, uint_64 } from '@snowluma/proton';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { getCollectionList } from '../../src/web/collection';

interface RequestHeadOracle {
  uin?: pb<1, uint_64>;
  sequence?: pb<2, uint_32>;
  commandType?: pb<3, uint_32>;
  operationId?: pb<4, uint_32>;
  clientVersion?: pb<5, uint_64>;
  platform?: pb<6, uint_32>;
  ticketType?: pb<7, uint_32>;
  reserved?: pb<10, uint_32>;
  ticket?: pb<11, string>;
  field14?: pb<14, uint_32>;
  field15?: pb<15, uint_32>;
}

interface GetCollectionListRequestOracle {
  field1?: pb<1, uint_32>;
  field2?: pb<2, uint_32>;
  field3?: pb<3, uint_32>;
  timeStamp?: pb<4, uint_64>;
  orderType?: pb<5, uint_32>;
  groupId?: pb<6, uint_64>;
  count?: pb<7, uint_32>;
  searchDown?: pb<8, uint_32>;
  field9?: pb<9, uint_32>;
}

interface RequestOperationOracle {
  getCollectionList?: pb<20000, GetCollectionListRequestOracle>;
}

interface RequestBodyOracle {
  operation?: pb<1, RequestOperationOracle>;
}

interface ResponseHeadOracle {
  trace?: pb<1, string>;
  retCode?: pb<101, int_32>;
  retMsg?: pb<102, string>;
  promptMsg?: pb<103, string>;
}

interface CollectionAuthorOracle {
  type?: pb<1, uint_32>;
  numId?: pb<2, uint_64>;
  strId?: pb<3, string>;
  groupId?: pb<4, uint_64>;
  groupName?: pb<5, string>;
  uid?: pb<6, string>;
}

interface CollectionTextSummaryOracle {
  text?: pb<1, string>;
  truncated?: pb<2, bool>;
}

interface CollectionPictureInfoOracle {
  url?: pb<1, string>;
  width?: pb<6, uint_32>;
  height?: pb<7, uint_32>;
}

interface CollectionLinkSummaryOracle {
  url?: pb<1, string>;
  title?: pb<2, string>;
  publisher?: pb<3, string>;
  brief?: pb<4, string>;
  picList?: pb_repeated<5, CollectionPictureInfoOracle>;
  contentType?: pb<6, uint_32>;
}

interface CollectionRichMediaSummaryOracle {
  title?: pb<1, string>;
  subTitle?: pb<2, string>;
  brief?: pb<3, string>;
  picList?: pb_repeated<4, CollectionPictureInfoOracle>;
  contentType?: pb<5, uint_32>;
  originalUri?: pb<6, string>;
  publisher?: pb<7, string>;
  richMediaVersion?: pb<8, uint_32>;
}

interface CollectionSummaryOracle {
  textSummary?: pb<1, CollectionTextSummaryOracle>;
  linkSummary?: pb<2, CollectionLinkSummaryOracle>;
  richMediaSummary?: pb<8, CollectionRichMediaSummaryOracle>;
}

interface CollectionItemOracle {
  cid?: pb<1, string>;
  type?: pb<2, uint_32>;
  status?: pb<3, uint_32>;
  author?: pb<4, CollectionAuthorOracle>;
  bid?: pb<5, uint_32>;
  category?: pb<8, uint_32>;
  createTime?: pb<9, uint_64>;
  collectTime?: pb<10, uint_64>;
  modifyTime?: pb<11, uint_64>;
  sequence?: pb<12, uint_64>;
  summary?: pb<15, CollectionSummaryOracle>;
  shareUrl?: pb<18, string>;
  customGroupId?: pb<20, uint_32>;
  securityBeat?: pb<21, bool>;
}

interface GetCollectionListResponseOracle {
  items?: pb_repeated<1, CollectionItemOracle>;
  totalCount?: pb<2, uint_32>;
  reachedBottom?: pb<3, uint_32>;
}

interface ResponseOperationOracle {
  getCollectionList?: pb<20000, GetCollectionListResponseOracle>;
}

interface ResponseBodyOracle {
  operation?: pb<2, ResponseOperationOracle>;
}

function encodeEnvelope(head: Uint8Array, body: Uint8Array): Uint8Array {
  const totalLength = 16 + head.length + body.length;
  const output = Buffer.alloc(totalLength);
  output.set([0x20, 0x13, 0x03, 0x29, 0x00, 0x01], 0);
  output.writeUInt32BE(totalLength, 6);
  output.writeUInt32BE(body.length, 10);
  output.set(head, 16);
  output.set(body, 16 + head.length);
  return output;
}

function decodeRequestEnvelope(bytes: Uint8Array): {
  head: RequestHeadOracle;
  request: GetCollectionListRequestOracle;
} {
  const input = Buffer.from(bytes);
  expect(Array.from(input.subarray(0, 6))).toEqual([0x20, 0x13, 0x03, 0x29, 0x00, 0x01]);
  expect(input.readUInt32BE(6)).toBe(input.length);
  const bodyLength = input.readUInt32BE(10);
  const headEnd = input.length - bodyLength;
  const head = protobuf_decode<RequestHeadOracle>(input.subarray(16, headEnd));
  const body = protobuf_decode<RequestBodyOracle>(input.subarray(headEnd));
  const request = body.operation?.getCollectionList;
  if (!request) throw new Error('missing collection request body');
  return { head, request };
}

function successResponse(items: CollectionItemOracle[], reachedBottom = 1): Uint8Array {
  return encodeEnvelope(
    protobuf_encode<ResponseHeadOracle>({ trace: 'response' }),
    protobuf_encode<ResponseBodyOracle>({
      operation: {
        getCollectionList: {
          items,
          totalCount: items.length,
          reachedBottom,
        },
      },
    }),
  );
}

function errorResponse(retCode: number, retMsg: string): Uint8Array {
  return encodeEnvelope(
    protobuf_encode<ResponseHeadOracle>({ trace: 'response', retCode, retMsg }),
    protobuf_encode<ResponseBodyOracle>({ operation: { getCollectionList: {} } }),
  );
}

describe('getCollectionList', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('uses the Weiyun collection envelope and maps the public result', async () => {
    const transport = vi.fn(async (request: {
      url: string;
      headers: Readonly<Record<string, string>>;
      body: Uint8Array;
      timeoutMs: number;
    }) => {
      expect(request.url).toBe('https://collector.weiyun.com/collector.fcg');
      expect(request.headers.Cookie).toBe('uin=10001;vt=27;vi=ticket-value;appid=5004');
      expect(request.headers.Range).toBe('bytes=0-');
      expect(request.timeoutMs).toBe(10_000);

      const { head, request: body } = decodeRequestEnvelope(request.body);
      expect(head).toMatchObject({
        uin: 10001n,
        sequence: 1,
        commandType: 1,
        operationId: 20000,
        clientVersion: 0x6105F5E164Fn,
        platform: 4,
        ticketType: 27,
        ticket: 'ticket-value',
        field14: 8,
        field15: 9,
      });
      expect(body).toMatchObject({
        field1: null,
        field2: null,
        field3: null,
        timeStamp: 0xFFFF_FFFF_FFFF_FFFFn,
        orderType: 2,
        groupId: null,
        count: 50,
        searchDown: 1,
        field9: null,
      });

      return successResponse([{
        cid: 'cid-1',
        type: 1,
        status: 0,
        author: {
          type: 2,
          numId: 123n,
          strId: 'author-id',
          groupId: 456n,
          groupName: 'group-name',
          uid: 'u_author',
        },
        bid: 3,
        category: 4,
        createTime: 1_000n,
        collectTime: 1_100n,
        modifyTime: 1_200n,
        sequence: 1_300n,
        summary: { textSummary: { text: 'hello', truncated: false } },
        shareUrl: 'https://example.invalid/share',
        customGroupId: 5,
        securityBeat: true,
      }]);
    });

    const result = await getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      category: 0,
      count: 50,
      transport,
    });

    expect(result).toEqual({
      errCode: 0,
      errMsg: '',
      collectionSearchList: {
        collectionItemList: [{
          cid: 'cid-1',
          type: 1,
          status: 0,
          author: {
            type: 2,
            numId: '123',
            strId: 'author-id',
            groupId: '456',
            groupName: 'group-name',
            uid: 'u_author',
          },
          bid: 3,
          category: 4,
          createTime: '1000',
          collectTime: '1100',
          modifyTime: '1200',
          sequence: '1300',
          summary: {
            textSummary: { text: 'hello', truncated: false },
            linkSummary: null,
            gallerySummary: null,
            audioSummary: null,
            videoSummary: null,
            fileSummary: null,
            locationSummary: null,
            richMediaSummary: null,
          },
          shareUrl: 'https://example.invalid/share',
          customGroupId: 5,
          securityBeat: true,
        }],
        hasMore: false,
        bottomTimeStamp: '1200',
      },
    });
    expect(transport).toHaveBeenCalledTimes(1);
  });

  it('maps a type 2 link summary whose brief is a string without throwing', async () => {
    // Regression: the old proto declared CollectionLinkSummary.picList at field 4,
    // but the server puts the `brief` string there. Decoding a string as a message
    // reads its first byte (0x43 = 'C') as a start-group tag and throws
    // "protobuf unterminated group". The link summary now maps field 4 as brief.
    const linkSummary: CollectionLinkSummaryOracle = {
      url: 'https://example.invalid/article',
      title: 'Example Article',
      publisher: 'Example Publisher',
      brief: 'Candy summary text that starts with a group-start byte',
      picList: [{ url: 'https://example.invalid/cover.jpg', width: 1280, height: 720 }],
      contentType: 1,
    };

    const result = await getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      transport: async () => successResponse([{
        cid: 'cid-link',
        type: 2,
        author: { numId: 1n },
        modifyTime: 1_200n,
        summary: { linkSummary },
      }], 1),
    });

    const item = result.collectionSearchList.collectionItemList[0];
    expect(item.type).toBe(2);
    expect(item.summary.linkSummary).toMatchObject({
      url: 'https://example.invalid/article',
      title: 'Example Article',
      publisher: 'Example Publisher',
      brief: 'Candy summary text that starts with a group-start byte',
      picList: [{ url: 'https://example.invalid/cover.jpg', field6: 1280, field7: 720 }],
      contentType: 1,
    });
    expect(item.summary.richMediaSummary).toBeNull();
  });

  it('maps a type 8 rich media summary at field 8', async () => {
    const richMediaSummary: CollectionRichMediaSummaryOracle = {
      title: 'Rich Media Title',
      subTitle: 'Rich Media Subtitle',
      brief: 'Rich media brief',
      picList: [{ url: 'https://example.invalid/rich.jpg', width: 800, height: 600 }],
      contentType: 2,
      originalUri: 'https://example.invalid/original',
      publisher: 'Rich Publisher',
      richMediaVersion: 3,
    };

    const result = await getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      transport: async () => successResponse([{
        cid: 'cid-rich',
        type: 8,
        author: { numId: 2n },
        modifyTime: 1_300n,
        summary: { richMediaSummary },
      }], 1),
    });

    const item = result.collectionSearchList.collectionItemList[0];
    expect(item.type).toBe(8);
    expect(item.summary.richMediaSummary).toMatchObject({
      title: 'Rich Media Title',
      subTitle: 'Rich Media Subtitle',
      brief: 'Rich media brief',
      picList: [{ url: 'https://example.invalid/rich.jpg', field6: 800, field7: 600 }],
      contentType: 2,
      originalUri: 'https://example.invalid/original',
      publisher: 'Rich Publisher',
      richMediaVersion: 3,
    });
    expect(item.summary.linkSummary).toBeNull();
  });

  it('filters categories while following a strictly decreasing cursor', async () => {
    const cursors: bigint[] = [];
    const sequences: number[] = [];
    const transport = vi.fn(async (request: { body: Uint8Array }) => {
      const decoded = decodeRequestEnvelope(request.body);
      cursors.push(decoded.request.timeStamp ?? 0n);
      sequences.push(decoded.head.sequence ?? 0);
      if (cursors.length === 1) {
        return successResponse([{
          cid: 'other',
          author: { numId: 1n },
          category: 2,
          modifyTime: 1_200n,
        }], 0);
      }
      return successResponse([{
        cid: 'match',
        author: { numId: 1n },
        category: 4,
        modifyTime: 900n,
      }], 1);
    });

    const result = await getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      category: 4,
      count: 1,
      transport,
    });

    expect(cursors).toEqual([0xFFFF_FFFF_FFFF_FFFFn, 1_200n]);
    expect(sequences).toEqual([1, 2]);
    expect(result.collectionSearchList.collectionItemList.map((item) => item.cid)).toEqual(['match']);
    expect(result.collectionSearchList.hasMore).toBe(false);
    expect(result.collectionSearchList.bottomTimeStamp).toBe('900');
  });

  it('checks later pages before reporting more filtered collection items', async () => {
    const transport = vi.fn(async (request: { body: Uint8Array }) => {
      const { head } = decodeRequestEnvelope(request.body);
      if (head.sequence === 1) {
        return successResponse([{
          cid: 'only-match',
          author: { numId: 1n },
          category: 4,
          modifyTime: 1_200n,
        }], 0);
      }
      return successResponse([{
        cid: 'different-category',
        author: { numId: 2n },
        category: 2,
        modifyTime: 1_100n,
      }], 1);
    });

    const result = await getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      category: 4,
      count: 1,
      transport,
    });

    expect(transport).toHaveBeenCalledTimes(2);
    expect(result.collectionSearchList.collectionItemList.map((item) => item.cid))
      .toEqual(['only-match']);
    expect(result.collectionSearchList.hasMore).toBe(false);
    expect(result.collectionSearchList.bottomTimeStamp).toBe('1200');
  });

  it('surfaces explicit service failures instead of returning an empty list', async () => {
    await expect(getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      transport: async () => errorResponse(-17, 'denied'),
    })).rejects.toThrow('collection service error -17: denied');
  });

  it('fails when the server reports more data without advancing pagination', async () => {
    const response = successResponse([], 0);
    await expect(getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      category: 4,
      count: 1,
      transport: async () => response,
    })).rejects.toThrow('collection pagination made no progress');
  });

  it('rejects an unbounded count before making a request', async () => {
    const transport = vi.fn();
    await expect(getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      count: 501,
      transport,
    })).rejects.toThrow('collection count must be between 1 and 500');
    expect(transport).not.toHaveBeenCalled();
  });

  it('stops after the explicit pagination budget', async () => {
    let calls = 0;
    const transport = vi.fn(async () => {
      calls += 1;
      return successResponse([{
        cid: `other-${calls}`,
        author: { numId: 1n },
        category: 2,
        modifyTime: BigInt(10_000 - calls),
      }], 0);
    });

    await expect(getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      category: 4,
      count: 1,
      transport,
    })).rejects.toThrow('collection pagination exceeded 100 pages');
    expect(transport).toHaveBeenCalledTimes(100);
  });

  it('bounds the total time spent paginating collection results', async () => {
    vi.useFakeTimers();
    try {
      const timeouts: number[] = [];
      let calls = 0;
      const transport = vi.fn(async (request: { timeoutMs: number }) => {
        calls += 1;
        timeouts.push(request.timeoutMs);
        vi.advanceTimersByTime(8_000);
        return successResponse([{
          cid: `other-${calls}`,
          author: { numId: 1n },
          category: 2,
          modifyTime: BigInt(10_000 - calls),
        }], 0);
      });

      await expect(getCollectionList({
        uin: '10001',
        pskey: 'ticket-value',
        category: 4,
        count: 1,
        transport,
      })).rejects.toThrow('collection pagination exceeded 60000ms');
      expect(transport).toHaveBeenCalledTimes(8);
      expect(timeouts.slice(0, 7)).toEqual(Array(7).fill(10_000));
      expect(timeouts[7]).toBe(4_000);
    } finally {
      vi.useRealTimers();
    }
  });

  it.each([
    [
      'cid',
      { author: { numId: 1n }, modifyTime: 1n },
      'collection item is missing cid',
    ],
    [
      'author',
      { cid: 'cid-1', modifyTime: 1n },
      'collection item cid-1 is missing author',
    ],
    [
      'modifyTime',
      { cid: 'cid-1', author: { numId: 1n } },
      'collection item cid-1 is missing modifyTime',
    ],
  ] as const)('rejects collection items missing required %s', async (_field, item, message) => {
    await expect(getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      transport: async () => successResponse([item], 1),
    })).rejects.toThrow(message);
  });

  it('uses the last returned item for the public cursor when count truncates a page', async () => {
    const result = await getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
      count: 1,
      transport: async () => successResponse([
        { cid: 'first', author: { numId: 1n }, modifyTime: 1_200n },
        { cid: 'not-returned', author: { numId: 2n }, modifyTime: 1_100n },
      ], 1),
    });

    expect(result.collectionSearchList.collectionItemList.map((item) => item.cid)).toEqual(['first']);
    expect(result.collectionSearchList.bottomTimeStamp).toBe('1200');
    expect(result.collectionSearchList.hasMore).toBe(true);
  });

  it('cancels a failed HTTP response body before surfacing the status', async () => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      status: 503,
      statusText: 'Unavailable',
    })));

    await expect(getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
    })).rejects.toThrow('collection HTTP request failed: 503 Unavailable');
    expect(cancel).toHaveBeenCalledOnce();
  });

  it.each([
    ['invalid', 'collection response has invalid content-length'],
    [`${16 * 1024 * 1024 + 1}`, 'collection response exceeds 16777216 bytes'],
  ])('cancels response bodies rejected by content-length %s', async (contentLength, message) => {
    const cancel = vi.fn();
    const stream = new ReadableStream<Uint8Array>({ cancel });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      headers: { 'Content-Length': contentLength },
    })));

    await expect(getCollectionList({
      uin: '10001',
      pskey: 'ticket-value',
    })).rejects.toThrow(message);
    expect(cancel).toHaveBeenCalledOnce();
  });

  it('preserves both the primary response error and cancellation failure', async () => {
    const primary = new Error('collection response has invalid content-length');
    const cleanup = new Error('cancel failed');
    const stream = new ReadableStream<Uint8Array>({
      cancel: () => { throw cleanup; },
    });
    vi.stubGlobal('fetch', vi.fn(async () => new Response(stream, {
      headers: { 'Content-Length': 'invalid' },
    })));

    let thrown: unknown;
    try {
      await getCollectionList({ uin: '10001', pskey: 'ticket-value' });
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(AggregateError);
    const aggregate = thrown as AggregateError;
    expect(aggregate.errors).toHaveLength(2);
    expect(aggregate.errors[0]).toMatchObject({ message: primary.message });
    expect(aggregate.errors[1]).toBe(cleanup);
  });
});
