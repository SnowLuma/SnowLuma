import type { BridgeInterface } from '../../bridge/bridge-interface';
import { createLogger } from '../../utils/logger';
import type { MediaStore } from '../media-store';
import type { JsonObject } from '../types';

const log = createLogger('OneBot');

export async function getImageInfo(
  mediaStore: MediaStore,
  file: string,
): Promise<JsonObject | null> {
  const cached = mediaStore.findImage(file);
  if (!cached) return null;
  const url = cached.url || cached.imageUrl || '';
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

  // Re-resolve via OIDB if the cached URL is missing or empty.
  // Mirrors NapCat's getPttUrl path: GetGroupPttUrl / GetPttUrl by fileUuid.
  let url = cached.url;
  if (!url && cached.mediaNode) {
    try {
      url = cached.isGroup
        ? await bridge.fetchGroupPttUrlByNode(cached.sessionId, cached.mediaNode)
        : await bridge.fetchPrivatePttUrlByNode(cached.mediaNode);
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
