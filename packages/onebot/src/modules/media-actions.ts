import { createLogger } from '@snowluma/common/logger';
import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import type { MessageElement } from '@snowluma/protocol/events';
import type { ImageUrlResolver } from '../event-converter';
import type { MediaStore } from '../media-store';
import type { MessageStore } from '../message-store';
import {
  deliverPttTransText,
  failPttTransWaiter,
  pttTransKey,
  waitPttTransText,
} from './ptt-trans-waiter';
import type { JsonObject } from '../types';

const log = createLogger('OneBot');

/**
 * Voice-to-text for a received ptt (issue #79 / NapCat `fetch_ptt_text`).
 * Resolves the message's `record` segment to its cached fingerprint
 * (uuid + md5 + duration/size/format), then drives QQ's native
 * `pttTrans.Trans{C2C,Group}PttReq` via the bridge and returns the text.
 */
export async function fetchPttText(
  messageStore: MessageStore,
  mediaStore: MediaStore,
  bridge: BridgeInterface,
  selfId: number,
  messageId: number,
): Promise<{ text: string }> {
  const event = messageStore.findEvent(messageId);
  if (!event) throw new Error('消息不存在或已被撤回');

  const segments = Array.isArray(event.message) ? event.message : [];
  let file = '';
  for (const seg of segments) {
    if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) continue;
    const so = seg as JsonObject;
    if (so.type !== 'record') continue;
    const data = (typeof so.data === 'object' && so.data !== null && !Array.isArray(so.data)) ? so.data as JsonObject : {};
    file = String(data.file ?? data.url ?? '');
    break;
  }
  if (!file) throw new Error('消息中不包含语音');

  const cached = mediaStore.findRecord(file);
  if (!cached) throw new Error('语音不在缓存中，无法转写');

  const isGroup = event.message_type === 'group' || cached.isGroup;
  const senderUin = Number(event.user_id) || 0;
  // c2c: receiver is self (inbound voice); group: the group uin.
  const peerUin = isGroup ? (Number(event.group_id) || cached.sessionId) : selfId;

  // Register the waiter BEFORE triggering, so a fast async push can't race
  // ahead of us. The trigger response may carry the text inline (already
  // transcribed) — settle immediately then; otherwise the Event 0x210
  // subType-61 push resolves the waiter via the event-pipeline subscription.
  const key = pttTransKey(selfId, messageId);
  const waiter = waitPttTransText(key, 20000);
  try {
    const syncText = await bridge.apis.extras.translatePttToText({
      isGroup,
      msgId: messageId,
      senderUin,
      peerUin,
      uuid: cached.fileId || '',
      md5Hex: cached.md5Hex ?? '',
      duration: cached.duration ?? 0,
      size: cached.fileSize ?? 0,
      format: cached.voiceFormat ?? 0,
    });
    if (syncText) deliverPttTransText(key, syncText);
  } catch (e) {
    failPttTransWaiter(key, e instanceof Error ? e : new Error(String(e)));
  }
  return { text: await waiter };
}

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
