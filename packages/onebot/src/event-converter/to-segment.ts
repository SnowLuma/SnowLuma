import type { MessageElement } from '@snowluma/protocol/events';
import type { JsonArray, JsonObject } from '../types';
import type { ToSegmentContext } from './element-codecs';
import { getElementCodec } from './element-codecs';
import { createLogger } from '@snowluma/common/logger';
import type { ConverterContext } from './index';
import { attachMessageMedia } from '../message-media';

const log = createLogger('OneBot');

export async function elementsToOneBotSegments(
    ctx: ConverterContext,
    elements: MessageElement[],
    isGroup: boolean,
    sessionId: number,
    options: { includeReplyContent?: boolean } = {},
): Promise<JsonArray> {
    const segmentCtx: ToSegmentContext = { ...ctx, isGroup, sessionId, mediaSegmentSink: null };
    const result: JsonArray = [];

    for (const element of elements) {
        let segment: JsonObject;

        // One malformed element shouldn't drop the whole message — skip it (with a
        // breadcrumb) and keep converting the rest.
        try {
            segment = await elementToSegment(element, segmentCtx);
        } catch (err) {
            log.warn(
                'segment convert skipped type=%s (%s)',
                element.type,
                err instanceof Error ? err.message : String(err),
            );
            continue;
        }

        // Forward quotes often refer to messages outside the local account's
        // history. Carry their inline content so consumers can resend the node.
        if (
            options.includeReplyContent &&
            element.type === 'reply' &&
            element.replyElements?.length
        ) {
            const message = await elementsToOneBotSegments(
                ctx,
                element.replyElements.filter((quoted) => quoted.type !== 'reply'),
                isGroup,
                sessionId,
            );

            if (message.length > 0) {
                const data = segment.data as JsonObject;
                data.message = message;

                if (element.replySenderUin) {
                    data.qq = String(element.replySenderUin);
                }

                if (element.replyTime !== undefined) {
                    data.time = String(element.replyTime);
                }

                if (element.replySeq) {
                    data.seq = String(element.replySeq);
                }
            }
        }

        // Persistence failures must propagate, not masquerade as bad wire elements.
        attachMessageMedia(segment, element);

        if (element.type === 'image' || element.type === 'record' || element.type === 'video') {
            await ctx.mediaSegmentSink?.(
                element.type,
                element,
                segment.data as JsonObject,
                isGroup,
                sessionId,
            );
        }

        result.push(segment);

        if (element.type === 'markdown' && element.text) {
            result.push({ type: 'text', data: { text: element.text } });
        }
    }

    return result;
}

async function elementToSegment(
    element: MessageElement,
    ctx: ToSegmentContext,
): Promise<JsonObject> {
    // S 收·转：按 element.type 查 codec 表；缺条目则走 default 透传（保持原兜底）。
    const codec = getElementCodec(element.type);

    if (codec?.toSegment) {
        return codec.toSegment(element, ctx);
    }

    log.warn('segment convert fallback type=%s reason=no receive-side codec', element.type);
    return { type: element.type, data: {} };
}
