import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { MessageElement } from '@snowluma/protocol/events';
import type { ImageUrlResolver } from '../event-converter';
import type { MediaStore } from '../media-store';
import type { JsonObject } from '../types';

const log = createLogger('OneBot');

export async function getImageInfo(
  mediaStore: MediaStore,
  file: string,
  imageUrlResolver?: ImageUrlResolver | null,
): Promise<JsonObject | null> {
  const cached = mediaStore.findImage(file);
  if (!cached) return null;

  let url = cached.url || cached.imageUrl || '';

  // Re-sign with a current rkey at lookup time. The stored `url` was signed
  // when the message first arrived and its rkey may have since expired — the
  // CDN then rejects the download with
  // `{"retcode":-5503010,"retmsg":"invalid rkey"}`. Resolving from the raw
  // (unsigned) `imageUrl` mints a fresh rkey, mirroring NapCat which
  // re-signs on every getImageUrl call instead of handing back a baked URL.
  if (imageUrlResolver && cached.imageUrl) {
    try {
      const element: MessageElement = { type: 'image', imageUrl: cached.imageUrl, subType: cached.subType };
      const fresh = await imageUrlResolver(element, cached.isGroup);
      if (fresh) url = fresh;
    } catch {
      // Best-effort: fall back to the stored URL on any resolver failure.
    }
  }

  return {
    file: url || cached.file,
    url,
    file_size: String(cached.fileSize ?? 0),
    file_name: cached.fileName || cached.file,
  };
}

export async function getRecordInfo(
  bridge: BridgeInterface,
  mediaStore: MediaStore,
  file: string,
): Promise<JsonObject | null> {
  const cached = mediaStore.findRecord(file);
  if (!cached) return null;
  let url = cached.url;
  if (!url && cached.mediaNode) {
    try {
      url = cached.isGroup
        ? await bridge.apis.groupFile.getPttUrl(cached.sessionId, cached.mediaNode)
        : await bridge.apis.groupFile.getPrivatePttUrl(cached.mediaNode);
      if (url) {
        mediaStore.updateRecordUrl(file, url);
      }
    } catch (err) {
      log.warn('get_record url refetch failed: %s', err instanceof Error ? err.message : String(err));
    }
  }
  return {
    file: url || cached.file,
    url: url || '',
    file_size: String(cached.fileSize ?? 0),
    file_name: cached.fileName || cached.file,
  };
}
