import type { MessageElement } from '@snowluma/protocol/events';
import type { JsonArray, JsonObject } from '../types';
import type {
  ImageUrlResolver,
  MediaSegmentSink,
  MediaUrlResolver,
  MessageIdResolver,
} from './index';
import { getElementCodec } from './element-codecs';
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
  selfId = 0,
): Promise<JsonArray> {
  const result: JsonArray = [];
  for (const element of elements) {
    // One malformed element shouldn't drop the whole message — skip it (with a
    // breadcrumb) and keep converting the rest.
    try {
      result.push(await elementToSegment(
        element, isGroup, sessionId,
        imageUrlResolver, mediaUrlResolver, messageIdResolver, mediaSegmentSink, selfId,
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
  selfId = 0,
): Promise<JsonObject> {
  // S 收·转：按 element.type 查 codec 表；缺条目则走 default 透传（保持原兜底）。
  const codec = getElementCodec(element.type);
  if (codec?.toSegment) {
    return codec.toSegment(element, {
      isGroup,
      sessionId,
      imageUrlResolver,
      mediaUrlResolver,
      messageIdResolver,
      mediaSegmentSink,
      selfId,
    });
  }
  log.warn('segment convert fallback type=%s reason=no receive-side codec', element.type);
  return { type: element.type, data: {} };
}
