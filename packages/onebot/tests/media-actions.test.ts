import { describe, it, expect, vi } from 'vitest';
import type { MessageElement } from '@snowluma/protocol/events';
import { getImageInfo } from '../src/modules/media-actions';
import type { CachedImage, MediaStore } from '../src/media-store';

const RAW = 'https://multimedia.nt.qq.com.cn/download?appid=1407&fileid=ABC';

function fakeStore(image: CachedImage | null): MediaStore {
  return { findImage: () => image } as unknown as MediaStore;
}

function cachedImage(overrides: Partial<CachedImage> = {}): CachedImage {
  return {
    file: 'ABC.jpg',
    url: `${RAW}&rkey=STALE`, // signed when the message arrived; now expired
    fileSize: 100,
    fileName: 'ABC.jpg',
    subType: 0,
    summary: '',
    isGroup: true,
    sessionId: 123,
    imageUrl: RAW, // raw, unsigned — the basis for re-signing
    ...overrides,
  };
}

describe('getImageInfo — rkey re-signing at lookup time', () => {
  it('re-signs from the raw imageUrl via the resolver', async () => {
    const resolver = vi.fn(async (el: MessageElement) => `${el.imageUrl}&rkey=FRESH`);

    const info = await getImageInfo(fakeStore(cachedImage()), 'ABC.jpg', resolver);

    expect(info?.url).toBe(`${RAW}&rkey=FRESH`);
    expect(info?.file).toBe(`${RAW}&rkey=FRESH`);
    expect(resolver).toHaveBeenCalledWith(
      expect.objectContaining({ type: 'image', imageUrl: RAW }),
      true, // isGroup carried through
    );
  });

  it('returns the stored URL when no resolver is wired', async () => {
    const info = await getImageInfo(fakeStore(cachedImage()), 'ABC.jpg');
    expect(info?.url).toBe(`${RAW}&rkey=STALE`);
  });

  it('falls back to the stored URL when the resolver throws', async () => {
    const resolver = vi.fn(async () => { throw new Error('rkey fetch failed'); });
    const info = await getImageInfo(fakeStore(cachedImage()), 'ABC.jpg', resolver);
    expect(info?.url).toBe(`${RAW}&rkey=STALE`);
  });

  it('skips re-signing when no raw imageUrl is stored', async () => {
    const resolver = vi.fn(async () => 'should-not-be-used');
    const info = await getImageInfo(fakeStore(cachedImage({ imageUrl: '' })), 'ABC.jpg', resolver);
    expect(resolver).not.toHaveBeenCalled();
    expect(info?.url).toBe(`${RAW}&rkey=STALE`);
  });

  it('returns null when the image is not cached', async () => {
    const info = await getImageInfo(fakeStore(null), 'missing.jpg');
    expect(info).toBeNull();
  });
});
