import type { MessageElement } from '@snowluma/protocol/events';
import type { JsonArray, JsonObject } from '../types';
import type {
  ImageUrlResolver,
  MediaSegmentSink,
  MediaUrlResolver,
  MessageIdResolver,
} from './index';
import { resolveReplyId } from './utils';
import { createLogger } from '@snowluma/common/logger';

const log = createLogger('OneBot');

export async function elementsToJson(
  elements: MessageElement[],
  isGroup: boolean,
  sessionId: number,
  imageUrlResolver?: ImageUrlResolver | null,
  mediaUrlResolver?: MediaUrlResolver | null,
  messageIdResolver?: MessageIdResolver | null,
  mediaSegmentSink?: MediaSegmentSink | null,
): Promise<JsonArray> {
  const result: JsonArray = [];
  for (const element of elements) {
    // One malformed element shouldn't drop the whole message — skip it (with a
    // breadcrumb) and keep converting the rest.
    try {
      result.push(await elementToSegment(
        element, isGroup, sessionId,
        imageUrlResolver, mediaUrlResolver, messageIdResolver, mediaSegmentSink,
      ));
    } catch (err) {
      log.warn('segment convert skipped type=%s (%s)', element.type,
        err instanceof Error ? err.message : String(err));
    }
  }
  return result;
}

async function elementToSegment(
  element: MessageElement,
  isGroup: boolean,
  sessionId: number,
  imageUrlResolver?: ImageUrlResolver | null,
  mediaUrlResolver?: MediaUrlResolver | null,
  messageIdResolver?: MessageIdResolver | null,
  mediaSegmentSink?: MediaSegmentSink | null,
): Promise<JsonObject> {
  if (element.type === 'text') {
    return { type: 'text', data: { text: element.text ?? '' } };
  }

  if (element.type === 'face') {
    return { type: 'face', data: { id: String(element.faceId ?? 0) } };
  }

  if (element.type === 'image') {
    const url = imageUrlResolver ? await imageUrlResolver(element, isGroup) : (element.imageUrl ?? '');
    const data: JsonObject = {
      url,
      file: element.fileId ?? '',
      sub_type: element.subType ?? 0,
      summary: element.summary ?? '',
    };
    if (mediaSegmentSink) mediaSegmentSink('image', element, data, isGroup, sessionId);
    return { type: 'image', data };
  }

  if (element.type === 'at') {
    const qq = (element.uid === 'all' || element.targetUin === 0)
      ? 'all'
      : String(element.targetUin ?? 0);
    return { type: 'at', data: { qq } };
  }

  if (element.type === 'reply') {
    const id = resolveReplyId(isGroup, sessionId, element.replySeq ?? 0, messageIdResolver);
    return { type: 'reply', data: { id: String(id) } };
  }

  if (element.type === 'record') {
    const url = mediaUrlResolver ? await mediaUrlResolver(element, isGroup, sessionId) : (element.url ?? '');
    const data: JsonObject = {
      file: element.fileName ?? element.fileId ?? '',
      url,
    };
    if (mediaSegmentSink) mediaSegmentSink('record', element, data, isGroup, sessionId);
    return { type: 'record', data };
  }

  if (element.type === 'video') {
    const url = mediaUrlResolver ? await mediaUrlResolver(element, isGroup, sessionId) : (element.url ?? '');
    const data: JsonObject = {
      file: element.fileName ?? element.fileId ?? '',
      url,
    };
    if (mediaSegmentSink) mediaSegmentSink('video', element, data, isGroup, sessionId);
    return { type: 'video', data };
  }

  if (element.type === 'json') {
    return { type: 'json', data: { data: element.text ?? '' } };
  }

  if (element.type === 'xml') {
    return {
      type: 'xml',
      data: {
        data: element.text ?? '',
        resid: element.subType ?? 35,
      },
    };
  }

  if (element.type === 'file') {
    const url = mediaUrlResolver ? await mediaUrlResolver(element, isGroup, sessionId) : (element.url ?? '');
    const fileName = element.fileName ?? '';
    const fileSize = element.fileSize ?? 0;
    const fileId = element.fileId ?? '';
    return {
      type: 'file',
      data: {
        // NapCat/LLOneBot-style canonical fields — most downstream
        // OneBot adapters read these (`file`/`file_id`/`file_size`).
        file: fileName,
        file_id: fileId,
        file_size: fileSize,
        // Legacy SnowLuma field names, kept for backward compat with
        // any consumer that already reads name/size/id.
        name: fileName,
        size: fileSize,
        id: fileId,
        url,
        file_hash: element.fileHash ?? '',
      },
    };
  }

  if (element.type === 'mface') {
    // Unify market faces (商城表情) to an `image` segment so OneBot clients
    // that don't special-case `mface` still render the sticker, while the
    // `emoji_id`/`emoji_package_id`/`key` markers let aware clients (and our
    // own send path) reproduce it as a real market face. Mirrors NapCat's
    // marketFaceElement → image conversion. The gxh URL is a self-contained
    // external link (no rkey), so we set it directly and skip mediaSegmentSink.
    const emojiId = element.emojiId ?? '';
    const dir = emojiId.slice(0, 2);
    const url = emojiId
      ? `https://gxh.vip.qq.com/club/item/parcel/item/${dir}/${emojiId}/raw300.gif`
      : '';
    return {
      type: 'image',
      data: {
        file: emojiId ? `${dir}-${emojiId}.gif` : '',
        url,
        summary: element.text ?? '',
        sub_type: 0,
        emoji_id: emojiId,
        emoji_package_id: element.emojiPackageId ?? 0,
        key: element.emojiKey ?? '',
      },
    };
  }

  if (element.type === 'poke') {
    return {
      type: 'poke',
      data: {
        type: element.subType ?? 0,
      },
    };
  }

  if (element.type === 'forward') {
    return {
      type: 'forward',
      data: { id: element.resId ?? '' },
    };
  }
  return { type: element.type, data: {} };
}
