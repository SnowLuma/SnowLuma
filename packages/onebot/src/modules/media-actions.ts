import { createLogger } from '@snowluma/common/logger';
import type { AccountInterface } from '@snowluma/core/account-interface';
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
  bridge: AccountInterface,
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
