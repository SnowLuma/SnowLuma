import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { MediaStore } from '../src/media-store';
import { convertEvent, type ConverterContext } from '../src/event-converter';
import type { GroupMessage, FriendMessage, MessageElement } from '@snowluma/protocol/events';

const SELF_ID = 10001;
const PEER_UIN = 22222;
const GROUP_ID = 99999;

function imageElement(overrides: Partial<MessageElement> = {}): MessageElement {
  return {
    type: 'image',
    fileId: 'abc.png',
    fileSize: 4242,
    imageUrl: 'https://example.com/abc.png',
    ...overrides,
  };
}

function recordElement(overrides: Partial<MessageElement> = {}): MessageElement {
  return {
    type: 'record',
    fileId: 'uuid-base64-fake',
    fileName: 'silk_test.amr',
    fileSize: 1024,
    duration: 3,
    fileHash: 'deadbeef',
    mediaNode: { fileUuid: 'uuid-base64-fake', storeId: 1 },
    ...overrides,
  };
}

function makeGroupMessage(elements: MessageElement[]): GroupMessage {
  return {
    kind: 'group_message', groupName: '',
    time: 1700000000,
    selfUin: SELF_ID,
    groupId: GROUP_ID,
    senderUin: PEER_UIN,
    senderNick: 'peer',
    senderCard: '',
    senderRole: 'member',
    msgSeq: 1,
    msgId: 1,
    elements,
  };
}

function makeFriendMessage(elements: MessageElement[]): FriendMessage {
  return {
    kind: 'friend_message',
    time: 1700000000,
    selfUin: SELF_ID,
    senderUin: PEER_UIN,
    senderNick: 'peer',
    msgSeq: 1,
    msgId: 1,
    elements,
  };
}

function tempDbPath(label: string): string {
  return path.join('data', 'test', `media-${label}-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

describe('MediaStore basic semantics', () => {
  const dbs: string[] = [];

  beforeEach(() => {
    dbs.length = 0;
  });

  afterEach(() => {
    for (const dbPath of dbs) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
      }
    }
  });

  function open(label: string, max?: number): MediaStore {
    const dbPath = tempDbPath(label);
    dbs.push(dbPath);
    return max !== undefined ? new MediaStore(dbPath, max) : new MediaStore(dbPath);
  }

  it('indexes images by file, fileName, and url', () => {
    const store = open('img-keys');
    store.rememberImage({
      file: 'abc.png',
      url: 'https://example.com/abc.png',
      fileSize: 4242,
      fileName: 'abc.png',
      subType: 0,
      summary: '',
      imageUrl: 'https://example.com/abc.png',
      isGroup: true,
      sessionId: GROUP_ID,
    });

    expect(store.findImage('abc.png')?.fileSize).toBe(4242);
    expect(store.findImage('https://example.com/abc.png')?.url).toBe('https://example.com/abc.png');
    expect(store.findImage('missing.png')).toBeNull();
    expect(store.findImage('')).toBeNull();
    store.close();
  });

  it('indexes records by file, fileName, fileId, and url', () => {
    const store = open('rec-keys');
    store.rememberRecord({
      file: 'silk_test.amr',
      fileId: 'uuid-base64-fake',
      url: 'https://example.com/voice.amr',
      fileSize: 1024,
      fileName: 'silk_test.amr',
      duration: 3,
      fileHash: 'deadbeef',
      mediaNode: { fileUuid: 'uuid-base64-fake' },
      isGroup: false,
      sessionId: PEER_UIN,
    });

    expect(store.findRecord('silk_test.amr')?.duration).toBe(3);
    expect(store.findRecord('uuid-base64-fake')?.fileId).toBe('uuid-base64-fake');
    expect(store.findRecord('https://example.com/voice.amr')?.url).toBe('https://example.com/voice.amr');
    expect(store.findRecord('nope')).toBeNull();
    store.close();
  });

  it('updates URLs in place across all alias keys', () => {
    const store = open('url-update');
    store.rememberRecord({
      file: 'silk_test.amr',
      fileId: 'uuid-base64-fake',
      url: '',
      fileSize: 1024,
      fileName: 'silk_test.amr',
      duration: 3,
      fileHash: '',
      mediaNode: { fileUuid: 'uuid-base64-fake' },
      isGroup: false,
      sessionId: PEER_UIN,
    });
    store.updateRecordUrl('silk_test.amr', 'https://refreshed.example.com/voice.amr');

    expect(store.findRecord('silk_test.amr')?.url).toBe('https://refreshed.example.com/voice.amr');
    expect(store.findRecord('uuid-base64-fake')?.url).toBe('https://refreshed.example.com/voice.amr');
    store.close();
  });

  it('survives close+reopen against the same db path', () => {
    const dbPath = tempDbPath('persist');
    dbs.push(dbPath);

    {
      const store = new MediaStore(dbPath);
      store.rememberImage({
        file: 'abc.png',
        url: 'https://example.com/abc.png',
        fileSize: 99,
        fileName: 'abc.png',
        subType: 0,
        summary: '',
        imageUrl: 'https://example.com/abc.png',
        isGroup: true,
        sessionId: GROUP_ID,
      });
      store.close();
    }

    {
      const store = new MediaStore(dbPath);
      const found = store.findImage('abc.png');
      expect(found).not.toBeNull();
      expect(found!.fileSize).toBe(99);
      // Alias index must also persist.
      expect(store.findImage('https://example.com/abc.png')?.fileSize).toBe(99);
      store.close();
    }
  });

  it('evicts old entries beyond the configured cap', () => {
    // EVICT_EVERY_N_REMEMBERS = 64 inside the store; we exercise the eviction
    // path by writing well past the cap so it triggers at least once.
    const cap = 80;
    const store = open('evict', cap);
    for (let i = 0; i < 200; i++) {
      store.rememberImage({
        file: `file-${i}.png`,
        url: `https://example.com/${i}.png`,
        fileSize: i,
        fileName: `file-${i}.png`,
        subType: 0,
        summary: '',
        imageUrl: '',
        isGroup: true,
        sessionId: GROUP_ID,
      });
    }
    const { images } = store.size();
    expect(images).toBeLessThanOrEqual(cap);
    // Most recent entries should still be present.
    expect(store.findImage('file-199.png')?.fileSize).toBe(199);
    store.close();
  });
});

describe('convertEvent media segment sink → MediaStore wiring', () => {
  const dbs: string[] = [];

  afterEach(() => {
    for (const dbPath of dbs) {
      for (const ext of ['', '-wal', '-shm']) {
        try { fs.unlinkSync(dbPath + ext); } catch { /* ignore */ }
      }
    }
    dbs.length = 0;
  });

  it('emits sink invocations for image segments with the right context', async () => {
    const sinkCalls: Array<{ type: string; isGroup: boolean; sessionId: number; file: string }> = [];
    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      messageIdResolver: null,
      mediaSegmentSink: (type, _element, data, isGroup, sessionId) => {
        sinkCalls.push({ type, isGroup, sessionId, file: String(data.file ?? '') });
      },
    };

    await convertEvent(ctx, makeGroupMessage([imageElement()]));
    await convertEvent(ctx, makeFriendMessage([recordElement()]));

    expect(sinkCalls).toEqual([
      { type: 'image', isGroup: true, sessionId: GROUP_ID, file: 'abc.png' },
      { type: 'record', isGroup: false, sessionId: PEER_UIN, file: 'silk_test.amr' },
    ]);
  });

  it('lets the sink populate a MediaStore that get_image-style lookups can use', async () => {
    const dbPath = tempDbPath('sink');
    dbs.push(dbPath);

    const store = new MediaStore(dbPath);
    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: (element) => element.imageUrl ?? '',
      mediaUrlResolver: async (element) => element.url ?? '',
      messageIdResolver: null,
      mediaSegmentSink: (type, element, data, isGroup, sessionId) => {
        const url = typeof data.url === 'string' ? data.url : '';
        const file = typeof data.file === 'string' ? data.file : '';
        if (type === 'image') {
          store.rememberImage({
            file: file || element.fileId || '',
            url,
            fileSize: element.fileSize ?? 0,
            fileName: element.fileId ?? '',
            subType: element.subType ?? 0,
            summary: element.summary ?? '',
            imageUrl: element.imageUrl ?? '',
            isGroup,
            sessionId,
          });
        } else {
          store.rememberRecord({
            file: file || element.fileName || element.fileId || '',
            fileId: element.fileId ?? '',
            url,
            fileSize: element.fileSize ?? 0,
            fileName: element.fileName ?? '',
            duration: element.duration ?? 0,
            fileHash: element.fileHash ?? '',
            mediaNode: element.mediaNode,
            isGroup,
            sessionId,
          });
        }
      },
    };

    await convertEvent(ctx, makeGroupMessage([imageElement()]));
    await convertEvent(ctx, makeFriendMessage([recordElement()]));

    const img = store.findImage('abc.png');
    expect(img).not.toBeNull();
    expect(img!.url).toBe('https://example.com/abc.png');
    expect(img!.fileSize).toBe(4242);
    expect(img!.isGroup).toBe(true);
    expect(img!.sessionId).toBe(GROUP_ID);

    const rec = store.findRecord('silk_test.amr');
    expect(rec).not.toBeNull();
    expect(rec!.fileId).toBe('uuid-base64-fake');
    expect(rec!.duration).toBe(3);
    expect(rec!.isGroup).toBe(false);
    expect(rec!.sessionId).toBe(PEER_UIN);
    // Alias lookup by fileUuid still works.
    expect(store.findRecord('uuid-base64-fake')?.fileName).toBe('silk_test.amr');
    store.close();
  });

  it('does not invoke the sink when no media segments are present', async () => {
    let calls = 0;
    const ctx: ConverterContext = {
      selfId: SELF_ID,
      imageUrlResolver: null,
      mediaUrlResolver: null,
      messageIdResolver: null,
      mediaSegmentSink: () => { calls++; },
    };
    await convertEvent(ctx, makeGroupMessage([{ type: 'text', text: 'hello' }]));
    expect(calls).toBe(0);
  });
});
