import { afterEach, describe, expect, it, vi } from 'vitest';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import {
  fetchPttText,
  getImageInfo,
  getRecordInfo,
} from '../src/modules/media-actions';
import {
  deliverPttTransText,
  failPttTransWaiter,
  pttTransKey,
} from '../src/modules/ptt-trans-waiter';
import type { CachedImage, CachedRecord, MediaStore } from '../src/media-store';
import type { MessageStore } from '../src/message-store';
import type { JsonObject } from '../src/types';

const SELF_ID = 7654321;
const PEER_UIN = 20002;
const GROUP_ID = 710010;
const RAW_IMAGE = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=DEF';

const usedPttKeys = new Set<string>();

afterEach(() => {
  vi.useRealTimers();
  for (const key of usedPttKeys) {
    failPttTransWaiter(key, new Error('test cleanup'));
  }
  usedPttKeys.clear();
});

function trackPttKey(selfId: number, messageId: number): string {
  const key = pttTransKey(selfId, messageId);
  usedPttKeys.add(key);
  return key;
}

function fakeMessageStore(event: JsonObject | null): MessageStore {
  return { findEvent: () => event } as unknown as MessageStore;
}

function fakeImageStore(image: CachedImage | null): MediaStore {
  return { findImage: () => image } as unknown as MediaStore;
}

function fakeRecordStore(
  record: CachedRecord | null,
  extras: { updateRecordUrl?: ReturnType<typeof vi.fn> } = {},
): MediaStore {
  return {
    findRecord: () => record,
    updateRecordUrl: extras.updateRecordUrl ?? vi.fn(),
  } as unknown as MediaStore;
}

function cachedImage(overrides: Partial<CachedImage> = {}): CachedImage {
  return {
    file: 'DEF.jpg',
    url: `${RAW_IMAGE}&rkey=STALE`,
    fileSize: 2048,
    fileName: 'DEF.jpg',
    subType: 1,
    summary: '',
    isGroup: false,
    sessionId: PEER_UIN,
    imageUrl: RAW_IMAGE,
    ...overrides,
  };
}

function cachedRecord(overrides: Partial<CachedRecord> = {}): CachedRecord {
  return {
    file: 'voice.silk',
    fileId: 'ptt-uuid-1',
    url: 'https://ptt.example/c2c.silk',
    fileSize: 4096,
    fileName: 'voice.silk',
    duration: 7,
    fileHash: 'deadbeef',
    isGroup: false,
    sessionId: PEER_UIN,
    md5Hex: 'aabbccddeeff00112233445566778899',
    voiceFormat: 1,
    ...overrides,
  };
}

function recordEvent(overrides: JsonObject = {}): JsonObject {
  return {
    message_type: 'private',
    user_id: PEER_UIN,
    message: [{ type: 'record', data: { file: 'voice.silk' } }],
    ...overrides,
  };
}

function fakeBridge(overrides: {
  translatePttToText?: ReturnType<typeof vi.fn>;
  getPttUrl?: ReturnType<typeof vi.fn>;
  getPrivatePttUrl?: ReturnType<typeof vi.fn>;
} = {}): BridgeInterface {
  return {
    apis: {
      extras: {
        translatePttToText: overrides.translatePttToText ?? vi.fn(async () => ''),
      },
      groupFile: {
        getPttUrl: overrides.getPttUrl ?? vi.fn(async () => ''),
        getPrivatePttUrl: overrides.getPrivatePttUrl ?? vi.fn(async () => ''),
      },
    },
  } as unknown as BridgeInterface;
}

describe('fetchPttText', () => {
  it('throws when the message event is missing', async () => {
    await expect(fetchPttText(
      fakeMessageStore(null),
      fakeRecordStore(cachedRecord()),
      fakeBridge(),
      SELF_ID,
      40001,
    )).rejects.toThrow('消息不存在或已被撤回');
  });

  it('throws when event.message is not an array', async () => {
    await expect(fetchPttText(
      fakeMessageStore({
        message_type: 'private',
        user_id: PEER_UIN,
        message: '[CQ:record,file=voice.silk]',
      }),
      fakeRecordStore(cachedRecord()),
      fakeBridge(),
      SELF_ID,
      40002,
    )).rejects.toThrow('消息中不包含语音');
  });

  it('throws when the message has no record segment', async () => {
    await expect(fetchPttText(
      fakeMessageStore({
        message_type: 'private',
        user_id: PEER_UIN,
        message: [{ type: 'text', data: { text: 'hi' } }],
      }),
      fakeRecordStore(cachedRecord()),
      fakeBridge(),
      SELF_ID,
      40003,
    )).rejects.toThrow('消息中不包含语音');
  });

  it('skips non-object segments and non-record types before finding a record', async () => {
    const translatePttToText = vi.fn(async () => '跳过垃圾段落后转写');
    const store = {
      findRecord: vi.fn((file: string) => file === 'keep.silk' ? cachedRecord({ file: 'keep.silk' }) : null),
    } as unknown as MediaStore;
    const event = {
      message_type: 'private',
      user_id: PEER_UIN,
      message: [
        null,
        'x',
        12,
        ['record'],
        { type: 'image', data: { file: 'pic.jpg' } },
        { type: 'record', data: { file: 'keep.silk' } },
      ],
    };

    trackPttKey(SELF_ID, 40004);
    await expect(fetchPttText(
      fakeMessageStore(event),
      store,
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40004,
    )).resolves.toEqual({ text: '跳过垃圾段落后转写' });
    expect(store.findRecord).toHaveBeenCalledWith('keep.silk');
  });

  it('throws when the record segment has no file and no url', async () => {
    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message: [{ type: 'record', data: {} }],
      })),
      fakeRecordStore(cachedRecord()),
      fakeBridge(),
      SELF_ID,
      40005,
    )).rejects.toThrow('消息中不包含语音');
  });

  it('throws when record data is not a plain object', async () => {
    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message: [{ type: 'record', data: 'voice.silk' }],
      })),
      fakeRecordStore(cachedRecord()),
      fakeBridge(),
      SELF_ID,
      40006,
    )).rejects.toThrow('消息中不包含语音');
  });

  it('throws when record data is an array', async () => {
    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message: [{ type: 'record', data: [{ file: 'voice.silk' }] }],
      })),
      fakeRecordStore(cachedRecord()),
      fakeBridge(),
      SELF_ID,
      40007,
    )).rejects.toThrow('消息中不包含语音');
  });

  it('does not fall back to url when file is an empty string', async () => {
    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message: [{ type: 'record', data: { file: '', url: 'https://ptt.example/ignored.silk' } }],
      })),
      fakeRecordStore(cachedRecord()),
      fakeBridge(),
      SELF_ID,
      40008,
    )).rejects.toThrow('消息中不包含语音');
  });

  it('looks the record up by data.url when data.file is absent', async () => {
    const translatePttToText = vi.fn(async () => 'url 字段转写');
    const store = {
      findRecord: vi.fn((file: string) => (
        file === 'https://ptt.example/by-url.silk'
          ? cachedRecord({ file: 'https://ptt.example/by-url.silk' })
          : null
      )),
    } as unknown as MediaStore;

    trackPttKey(SELF_ID, 40009);
    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message: [{ type: 'record', data: { url: 'https://ptt.example/by-url.silk' } }],
      })),
      store,
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40009,
    )).resolves.toEqual({ text: 'url 字段转写' });
    expect(store.findRecord).toHaveBeenCalledWith('https://ptt.example/by-url.silk');
  });

  it('uses the first record segment even when a later one exists', async () => {
    const translatePttToText = vi.fn(async () => '第一段');
    const store = {
      findRecord: vi.fn((file: string) => (
        file === 'first.silk' ? cachedRecord({ file: 'first.silk' }) : null
      )),
    } as unknown as MediaStore;

    trackPttKey(SELF_ID, 40010);
    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message: [
          { type: 'record', data: { file: 'first.silk' } },
          { type: 'record', data: { file: 'second.silk' } },
        ],
      })),
      store,
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40010,
    )).resolves.toEqual({ text: '第一段' });
    expect(store.findRecord).toHaveBeenCalledWith('first.silk');
    expect(store.findRecord).not.toHaveBeenCalledWith('second.silk');
  });

  it('stringifies a numeric file id before cache lookup', async () => {
    const translatePttToText = vi.fn(async () => '数字 file');
    const store = {
      findRecord: vi.fn((file: string) => file === '9001' ? cachedRecord({ file: '9001' }) : null),
    } as unknown as MediaStore;

    trackPttKey(SELF_ID, 40011);
    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message: [{ type: 'record', data: { file: 9001 } }],
      })),
      store,
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40011,
    )).resolves.toEqual({ text: '数字 file' });
    expect(store.findRecord).toHaveBeenCalledWith('9001');
  });

  it('throws when the record is not in the media cache', async () => {
    await expect(fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(null),
      fakeBridge(),
      SELF_ID,
      40012,
    )).rejects.toThrow('语音不在缓存中，无法转写');
  });

  it('transcribes a private ptt with selfId as peerUin and inline text', async () => {
    const translatePttToText = vi.fn(async () => '今天天气不错');
    trackPttKey(SELF_ID, 40013);

    await expect(fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40013,
    )).resolves.toEqual({ text: '今天天气不错' });

    expect(translatePttToText).toHaveBeenCalledWith({
      isGroup: false,
      msgId: 40013,
      senderUin: 20002,
      peerUin: 7654321,
      uuid: 'ptt-uuid-1',
      md5Hex: 'aabbccddeeff00112233445566778899',
      duration: 7,
      size: 4096,
      format: 1,
    });
  });

  it('treats message_type group as a group ptt and uses group_id as peerUin', async () => {
    const translatePttToText = vi.fn(async () => '群语音');
    trackPttKey(SELF_ID, 40014);

    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message_type: 'group',
        group_id: GROUP_ID,
        user_id: PEER_UIN,
      })),
      fakeRecordStore(cachedRecord({ isGroup: false, sessionId: 1 })),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40014,
    )).resolves.toEqual({ text: '群语音' });

    expect(translatePttToText).toHaveBeenCalledWith({
      isGroup: true,
      msgId: 40014,
      senderUin: 20002,
      peerUin: 710010,
      uuid: 'ptt-uuid-1',
      md5Hex: 'aabbccddeeff00112233445566778899',
      duration: 7,
      size: 4096,
      format: 1,
    });
  });

  it('uses cached.sessionId when group_id is missing or zero', async () => {
    const translatePttToText = vi.fn(async () => 'session 回退');
    trackPttKey(SELF_ID, 40015);

    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message_type: 'group',
        group_id: 0,
        user_id: PEER_UIN,
      })),
      fakeRecordStore(cachedRecord({ isGroup: true, sessionId: 888001 })),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40015,
    )).resolves.toEqual({ text: 'session 回退' });

    expect(translatePttToText).toHaveBeenCalledWith({
      isGroup: true,
      msgId: 40015,
      senderUin: 20002,
      peerUin: 888001,
      uuid: 'ptt-uuid-1',
      md5Hex: 'aabbccddeeff00112233445566778899',
      duration: 7,
      size: 4096,
      format: 1,
    });
  });

  it('treats a private event as group when the cached record is a group ptt', async () => {
    const translatePttToText = vi.fn(async () => '缓存标记群');
    trackPttKey(SELF_ID, 40016);

    await expect(fetchPttText(
      fakeMessageStore(recordEvent({
        message_type: 'private',
        group_id: 555000,
      })),
      fakeRecordStore(cachedRecord({ isGroup: true, sessionId: 555000 })),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40016,
    )).resolves.toEqual({ text: '缓存标记群' });

    expect(translatePttToText).toHaveBeenCalledWith({
      isGroup: true,
      msgId: 40016,
      senderUin: 20002,
      peerUin: 555000,
      uuid: 'ptt-uuid-1',
      md5Hex: 'aabbccddeeff00112233445566778899',
      duration: 7,
      size: 4096,
      format: 1,
    });
  });

  it('defaults senderUin and fingerprint fields when they are missing', async () => {
    const translatePttToText = vi.fn(async () => '缺省指纹');
    trackPttKey(SELF_ID, 40017);

    await expect(fetchPttText(
      fakeMessageStore({
        message_type: 'private',
        message: [{ type: 'record', data: { file: 'voice.silk' } }],
      }),
      fakeRecordStore(cachedRecord({
        fileId: '',
        md5Hex: undefined,
        duration: undefined as unknown as number,
        fileSize: undefined as unknown as number,
        voiceFormat: undefined,
      })),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40017,
    )).resolves.toEqual({ text: '缺省指纹' });

    expect(translatePttToText).toHaveBeenCalledWith({
      isGroup: false,
      msgId: 40017,
      senderUin: 0,
      peerUin: 7654321,
      uuid: '',
      md5Hex: '',
      duration: 0,
      size: 0,
      format: 0,
    });
  });

  it('coerces a string user_id to senderUin', async () => {
    const translatePttToText = vi.fn(async () => '字符串 uin');
    trackPttKey(SELF_ID, 40018);

    await expect(fetchPttText(
      fakeMessageStore(recordEvent({ user_id: '20002' })),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40018,
    )).resolves.toEqual({ text: '字符串 uin' });

    expect(translatePttToText).toHaveBeenCalledWith({
      isGroup: false,
      msgId: 40018,
      senderUin: 20002,
      peerUin: 7654321,
      uuid: 'ptt-uuid-1',
      md5Hex: 'aabbccddeeff00112233445566778899',
      duration: 7,
      size: 4096,
      format: 1,
    });
  });

  it('registers the waiter before triggering so an inline push cannot race', async () => {
    const key = trackPttKey(SELF_ID, 40019);
    const translatePttToText = vi.fn(async () => {
      deliverPttTransText(key, '推送先到');
      return '';
    });

    await expect(fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40019,
    )).resolves.toEqual({ text: '推送先到' });
  });

  it('keeps the push text when the trigger later also returns inline text', async () => {
    const key = trackPttKey(SELF_ID, 40020);
    const translatePttToText = vi.fn(async () => {
      deliverPttTransText(key, '推送文本');
      return '同步文本';
    });

    await expect(fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40020,
    )).resolves.toEqual({ text: '推送文本' });
  });

  it('waits for an async push when the trigger returns an empty string', async () => {
    const key = trackPttKey(SELF_ID, 40021);
    const translatePttToText = vi.fn(async () => {
      queueMicrotask(() => deliverPttTransText(key, '异步推送转写'));
      return '';
    });

    await expect(fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40021,
    )).resolves.toEqual({ text: '异步推送转写' });
  });

  it('rejects with the trigger Error', async () => {
    trackPttKey(SELF_ID, 40022);
    const err = new Error('桥接失败');
    const translatePttToText = vi.fn(async () => {
      throw err;
    });

    await expect(fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40022,
    )).rejects.toBe(err);
  });

  it('wraps a non-Error trigger rejection', async () => {
    trackPttKey(SELF_ID, 40023);
    const translatePttToText = vi.fn(async () => {
      throw 'boom';
    });

    await expect(fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40023,
    )).rejects.toThrow('boom');
  });

  it('times out after 20000ms when neither inline text nor a push arrives', async () => {
    vi.useFakeTimers();
    trackPttKey(SELF_ID, 40024);
    const translatePttToText = vi.fn(async () => '');

    const pending = fetchPttText(
      fakeMessageStore(recordEvent()),
      fakeRecordStore(cachedRecord()),
      fakeBridge({ translatePttToText }),
      SELF_ID,
      40024,
    );
    const rejected = expect(pending).rejects.toThrow('语音转文字超时（未收到结果推送）');
    await vi.advanceTimersByTimeAsync(19_999);
    await vi.advanceTimersByTimeAsync(1);
    await rejected;
  });
});

describe('getImageInfo', () => {
  it('returns the full info object after a successful re-sign', async () => {
    const resolver = vi.fn(async () => `${RAW_IMAGE}&rkey=FRESH`);

    await expect(getImageInfo(fakeImageStore(cachedImage()), 'DEF.jpg', resolver)).resolves.toEqual({
      file: `${RAW_IMAGE}&rkey=FRESH`,
      url: `${RAW_IMAGE}&rkey=FRESH`,
      file_size: '2048',
      file_name: 'DEF.jpg',
    });
    expect(resolver).toHaveBeenCalledWith(
      { type: 'image', imageUrl: RAW_IMAGE, subType: 1 },
      false,
    );
  });

  it('keeps the stored URL when the resolver returns an empty string', async () => {
    const resolver = vi.fn(async () => '');
    await expect(getImageInfo(fakeImageStore(cachedImage()), 'DEF.jpg', resolver)).resolves.toEqual({
      file: `${RAW_IMAGE}&rkey=STALE`,
      url: `${RAW_IMAGE}&rkey=STALE`,
      file_size: '2048',
      file_name: 'DEF.jpg',
    });
  });

  it('does not call a null resolver', async () => {
    await expect(getImageInfo(fakeImageStore(cachedImage()), 'DEF.jpg', null)).resolves.toEqual({
      file: `${RAW_IMAGE}&rkey=STALE`,
      url: `${RAW_IMAGE}&rkey=STALE`,
      file_size: '2048',
      file_name: 'DEF.jpg',
    });
  });

  it('falls file back to the cache key when both url fields are empty', async () => {
    await expect(getImageInfo(fakeImageStore(cachedImage({
      file: 'orphan.jpg',
      url: '',
      imageUrl: '',
      fileName: 'named.jpg',
      fileSize: 12,
    })), 'orphan.jpg')).resolves.toEqual({
      file: 'orphan.jpg',
      url: '',
      file_size: '12',
      file_name: 'named.jpg',
    });
  });

  it('uses imageUrl as the unsigned url when the stored signed url is empty', async () => {
    await expect(getImageInfo(fakeImageStore(cachedImage({
      url: '',
      imageUrl: RAW_IMAGE,
    })), 'DEF.jpg')).resolves.toEqual({
      file: RAW_IMAGE,
      url: RAW_IMAGE,
      file_size: '2048',
      file_name: 'DEF.jpg',
    });
  });

  it('stringifies a missing fileSize as 0 and falls file_name back to file', async () => {
    await expect(getImageInfo(fakeImageStore(cachedImage({
      file: 'fallback-name.jpg',
      fileName: '',
      fileSize: undefined as unknown as number,
    })), 'fallback-name.jpg')).resolves.toEqual({
      file: `${RAW_IMAGE}&rkey=STALE`,
      url: `${RAW_IMAGE}&rkey=STALE`,
      file_size: '0',
      file_name: 'fallback-name.jpg',
    });
  });

  it('passes isGroup true through to the resolver', async () => {
    const resolver = vi.fn(async () => 'https://cdn.example/group-fresh');
    await expect(getImageInfo(
      fakeImageStore(cachedImage({ isGroup: true, sessionId: GROUP_ID })),
      'DEF.jpg',
      resolver,
    )).resolves.toEqual({
      file: 'https://cdn.example/group-fresh',
      url: 'https://cdn.example/group-fresh',
      file_size: '2048',
      file_name: 'DEF.jpg',
    });
    expect(resolver).toHaveBeenCalledWith(
      { type: 'image', imageUrl: RAW_IMAGE, subType: 1 },
      true,
    );
  });
});

describe('getRecordInfo', () => {
  it('returns null when the record is not cached', async () => {
    await expect(getRecordInfo(fakeBridge(), fakeRecordStore(null), 'missing.silk')).resolves.toBeNull();
  });

  it('returns the stored url without refetching', async () => {
    const getPttUrl = vi.fn(async () => 'https://ptt.example/should-not-run');
    const getPrivatePttUrl = vi.fn(async () => 'https://ptt.example/should-not-run');
    const updateRecordUrl = vi.fn();

    await expect(getRecordInfo(
      fakeBridge({ getPttUrl, getPrivatePttUrl }),
      fakeRecordStore(cachedRecord({
        url: 'https://ptt.example/cached.silk',
        mediaNode: { fileUuid: 'uuid-1' },
      }), { updateRecordUrl }),
      'voice.silk',
    )).resolves.toEqual({
      file: 'https://ptt.example/cached.silk',
      url: 'https://ptt.example/cached.silk',
      file_size: '4096',
      file_name: 'voice.silk',
    });
    expect(getPttUrl).not.toHaveBeenCalled();
    expect(getPrivatePttUrl).not.toHaveBeenCalled();
    expect(updateRecordUrl).not.toHaveBeenCalled();
  });

  it('does not refetch when the url is empty and there is no mediaNode', async () => {
    const getPttUrl = vi.fn(async () => 'https://ptt.example/group');
    const getPrivatePttUrl = vi.fn(async () => 'https://ptt.example/private');

    await expect(getRecordInfo(
      fakeBridge({ getPttUrl, getPrivatePttUrl }),
      fakeRecordStore(cachedRecord({ url: '', mediaNode: undefined })),
      'voice.silk',
    )).resolves.toEqual({
      file: 'voice.silk',
      url: '',
      file_size: '4096',
      file_name: 'voice.silk',
    });
    expect(getPttUrl).not.toHaveBeenCalled();
    expect(getPrivatePttUrl).not.toHaveBeenCalled();
  });

  it('refetches a group ptt url and writes it back under the lookup key', async () => {
    const mediaNode = { fileUuid: 'group-uuid', storeId: 1 };
    const getPttUrl = vi.fn(async () => 'https://ptt.example/group-fresh');
    const getPrivatePttUrl = vi.fn(async () => 'https://ptt.example/private');
    const updateRecordUrl = vi.fn();

    await expect(getRecordInfo(
      fakeBridge({ getPttUrl, getPrivatePttUrl }),
      fakeRecordStore(cachedRecord({
        file: 'primary.silk',
        url: '',
        isGroup: true,
        sessionId: GROUP_ID,
        mediaNode,
      }), { updateRecordUrl }),
      'alias.silk',
    )).resolves.toEqual({
      file: 'https://ptt.example/group-fresh',
      url: 'https://ptt.example/group-fresh',
      file_size: '4096',
      file_name: 'voice.silk',
    });
    expect(getPttUrl).toHaveBeenCalledWith(710010, mediaNode);
    expect(getPrivatePttUrl).not.toHaveBeenCalled();
    expect(updateRecordUrl).toHaveBeenCalledWith('alias.silk', 'https://ptt.example/group-fresh');
  });

  it('refetches a private ptt url from the media node only', async () => {
    const mediaNode = { fileUuid: 'c2c-uuid' };
    const getPttUrl = vi.fn(async () => 'https://ptt.example/group');
    const getPrivatePttUrl = vi.fn(async () => 'https://ptt.example/private-fresh');
    const updateRecordUrl = vi.fn();

    await expect(getRecordInfo(
      fakeBridge({ getPttUrl, getPrivatePttUrl }),
      fakeRecordStore(cachedRecord({
        url: '',
        isGroup: false,
        mediaNode,
      }), { updateRecordUrl }),
      'voice.silk',
    )).resolves.toEqual({
      file: 'https://ptt.example/private-fresh',
      url: 'https://ptt.example/private-fresh',
      file_size: '4096',
      file_name: 'voice.silk',
    });
    expect(getPrivatePttUrl).toHaveBeenCalledWith(mediaNode);
    expect(getPttUrl).not.toHaveBeenCalled();
    expect(updateRecordUrl).toHaveBeenCalledWith('voice.silk', 'https://ptt.example/private-fresh');
  });

  it('does not write back an empty refetch result', async () => {
    const updateRecordUrl = vi.fn();
    const getPrivatePttUrl = vi.fn(async () => '');

    await expect(getRecordInfo(
      fakeBridge({ getPrivatePttUrl }),
      fakeRecordStore(cachedRecord({
        url: '',
        mediaNode: { fileUuid: 'empty-uuid' },
      }), { updateRecordUrl }),
      'voice.silk',
    )).resolves.toEqual({
      file: 'voice.silk',
      url: '',
      file_size: '4096',
      file_name: 'voice.silk',
    });
    expect(updateRecordUrl).not.toHaveBeenCalled();
  });

  it('returns the cached file after a refetch Error', async () => {
    const updateRecordUrl = vi.fn();
    const getPttUrl = vi.fn(async () => {
      throw new Error('cdn timeout');
    });

    await expect(getRecordInfo(
      fakeBridge({ getPttUrl }),
      fakeRecordStore(cachedRecord({
        file: 'keep.silk',
        url: '',
        isGroup: true,
        sessionId: GROUP_ID,
        mediaNode: { fileUuid: 'fail-uuid' },
      }), { updateRecordUrl }),
      'keep.silk',
    )).resolves.toEqual({
      file: 'keep.silk',
      url: '',
      file_size: '4096',
      file_name: 'voice.silk',
    });
    expect(updateRecordUrl).not.toHaveBeenCalled();
  });

  it('returns the cached file after a non-Error refetch rejection', async () => {
    const getPrivatePttUrl = vi.fn(async () => {
      throw 'offline';
    });

    await expect(getRecordInfo(
      fakeBridge({ getPrivatePttUrl }),
      fakeRecordStore(cachedRecord({
        url: '',
        isGroup: false,
        mediaNode: { fileUuid: 'offline-uuid' },
      })),
      'voice.silk',
    )).resolves.toEqual({
      file: 'voice.silk',
      url: '',
      file_size: '4096',
      file_name: 'voice.silk',
    });
  });

  it('stringifies a missing fileSize as 0 and falls file_name back to file', async () => {
    await expect(getRecordInfo(
      fakeBridge(),
      fakeRecordStore(cachedRecord({
        file: 'fallback.silk',
        fileName: '',
        fileSize: undefined as unknown as number,
        url: 'https://ptt.example/named.silk',
      })),
      'fallback.silk',
    )).resolves.toEqual({
      file: 'https://ptt.example/named.silk',
      url: 'https://ptt.example/named.silk',
      file_size: '0',
      file_name: 'fallback.silk',
    });
  });
});
