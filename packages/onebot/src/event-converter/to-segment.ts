import type { MessageElement } from '@snowluma/protocol/events';
import type { JsonArray, JsonObject } from '../types';
import type {
  ImageUrlResolver,
  MediaSegmentSink,
  MediaUrlResolver,
  MessageIdResolver,
} from './index';
import { resolveReplyId } from './utils';

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
    result.push(await elementToSegment(
      element, isGroup, sessionId,
      imageUrlResolver, mediaUrlResolver, messageIdResolver, mediaSegmentSink,
    ));
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
    return {
      type: 'file',
      data: {
        name: element.fileName ?? '',
        size: element.fileSize ?? 0,
        id: element.fileId ?? '',
        url,
        file_hash: element.fileHash ?? '',
      },
    };
  }

  if (element.type === 'mface') {
    return {
      type: 'mface',
      data: {
        name: element.text ?? '',
        tab_id: element.faceId ?? 0,
        sub_type: element.subType ?? 0,
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
