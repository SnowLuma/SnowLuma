import { describe, it, expect, vi } from 'vitest';
import { MediaIndexer } from '../src/media-indexer';
import type { MessageElement } from '@snowluma/protocol/events';

function makeMediaStore() {
  return {
    rememberImage: vi.fn(),
    rememberRecord: vi.fn(),
    rememberVideo: vi.fn(),
  };
}

describe('MediaIndexer', () => {
  it('image: maps element fields into rememberImage with file fallback to fileId', () => {
    const store = makeMediaStore();
    const indexer = new MediaIndexer(store as any);
    const element: MessageElement = {
      type: 'image',
      fileId: 'img-fid',
      fileSize: 1024,
      subType: 1,
      summary: '[image]',
      imageUrl: 'http://orig',
      md5Hex: 'abcd',
      sha1Hex: 'efgh',
      width: 800,
      height: 600,
      picFormat: 1000,
    };
    indexer.remember('image', element, { url: 'http://x', file: '' }, true, 99999);

    expect(store.rememberImage).toHaveBeenCalledOnce();
    const arg = store.rememberImage.mock.calls[0]![0];
    expect(arg).toMatchObject({
      file: 'img-fid',  // data.file was '', fell back to element.fileId
      url: 'http://x',
      fileSize: 1024,
      subType: 1,
      summary: '[image]',
      imageUrl: 'http://orig',
      isGroup: true,
      sessionId: 99999,
      md5Hex: 'abcd',
      sha1Hex: 'efgh',
      width: 800,
      height: 600,
      picFormat: 1000,
    });
  });

  it('record: maps element fields into rememberRecord with file fallback chain', () => {
    const store = makeMediaStore();
    const indexer = new MediaIndexer(store as any);
    const element: MessageElement = {
      type: 'record',
      fileId: 'rec-fid',
      fileName: 'voice.amr',
      fileSize: 2048,
      duration: 5,
      fileHash: 'h',
      mediaNode: { fileUuid: 'uuid' },
      md5Hex: 'm',
      sha1Hex: 's',
      voiceFormat: 1,
    };
    indexer.remember('record', element, { url: 'http://r', file: '' }, false, 12345);

    const arg = store.rememberRecord.mock.calls[0]![0];
    expect(arg.file).toBe('voice.amr');  // data.file '' → element.fileName
    expect(arg.fileId).toBe('rec-fid');
    expect(arg.duration).toBe(5);
    expect(arg.isGroup).toBe(false);
    expect(arg.sessionId).toBe(12345);
    expect(arg.voiceFormat).toBe(1);
  });

  it('video: maps element fields into rememberVideo', () => {
    const store = makeMediaStore();
    const indexer = new MediaIndexer(store as any);
    const element: MessageElement = {
      type: 'video',
      fileId: 'vid-fid',
      fileName: 'clip.mp4',
      fileSize: 99999,
      duration: 30,
      width: 1920,
      height: 1080,
      videoFormat: 2,
    };
    indexer.remember('video', element, { url: 'http://v', file: 'override.mp4' }, true, 11111);

    const arg = store.rememberVideo.mock.calls[0]![0];
    expect(arg.file).toBe('override.mp4');  // data.file used when non-empty
    expect(arg.fileId).toBe('vid-fid');
    expect(arg.duration).toBe(30);
    expect(arg.width).toBe(1920);
    expect(arg.videoFormat).toBe(2);
  });

  it('falls back to element.fileId when data.file AND element.fileName are missing (record)', () => {
    const store = makeMediaStore();
    const indexer = new MediaIndexer(store as any);
    const element: MessageElement = { type: 'record', fileId: 'only-fid' };
    indexer.remember('record', element, { url: '', file: '' }, false, 1);
    expect(store.rememberRecord.mock.calls[0]![0].file).toBe('only-fid');
  });

  it('defaults missing numeric fields to 0 / missing strings to ""', () => {
    const store = makeMediaStore();
    const indexer = new MediaIndexer(store as any);
    indexer.remember('image', { type: 'image' }, { url: '', file: '' }, false, 0);
    const arg = store.rememberImage.mock.calls[0]![0];
    expect(arg.fileSize).toBe(0);
    expect(arg.subType).toBe(0);
    expect(arg.summary).toBe('');
    expect(arg.imageUrl).toBe('');
  });

  it('only the matching rememberX is called', () => {
    const store = makeMediaStore();
    const indexer = new MediaIndexer(store as any);
    indexer.remember('image', { type: 'image' }, { url: '', file: 'a' }, true, 1);
    expect(store.rememberImage).toHaveBeenCalledOnce();
    expect(store.rememberRecord).not.toHaveBeenCalled();
    expect(store.rememberVideo).not.toHaveBeenCalled();
  });
});
