import type { BridgeInterface } from '@snowluma/core/bridge-interface';
import { createLogger } from '@snowluma/common/logger';
import type { ImageUrlResolver } from '../event-converter';
import type { CachedImage, MediaStore } from '../media-store';
import type { MessageStore } from '../message-store';
import type { OneBotInstanceContext } from '../instance-context';
import { resolveRemoteMediaUrl } from '../media-url-resolver';
import { segmentsToRawMessage } from '../helper/cq';
import { pttTransKey, requestPttTransText } from './ptt-trans-waiter';
import type { JsonObject, JsonValue } from '../types';

const log = createLogger('OneBot');

type StoredMediaSegment = JsonObject & { type: 'image' | 'record' | 'video'; data: JsonObject };

function isStoredMediaSegment(segment: JsonValue): segment is StoredMediaSegment {
    return (
        segment !== null &&
        typeof segment === 'object' &&
        !Array.isArray(segment) &&
        (segment.type === 'image' || segment.type === 'record' || segment.type === 'video') &&
        segment.data !== null &&
        typeof segment.data === 'object' &&
        !Array.isArray(segment.data)
    );
}

export async function refreshMessageMedia(
    ref: Pick<OneBotInstanceContext, 'bridge' | 'messageStore' | 'mediaStore' | 'converterCtx'>,
    messageId: number,
    event: JsonObject,
): Promise<void> {
    if (!Array.isArray(event.message)) {
        return;
    }

    const segments = event.message.filter(isStoredMediaSegment);
    const voiceVideoSegments = segments.filter((segment) => segment.type !== 'image');
    const media =
        voiceVideoSegments.length > 0
            ? (await ref.messageStore.findMedia(messageId))?.filter(
                  (element) => element.type !== 'image',
              )
            : null;
    const meta = voiceVideoSegments.length > 0 ? await ref.messageStore.findMeta(messageId) : null;
    // Validate the ordered association once; a filename lookup can select another upload.
    const voiceVideo =
        meta &&
        media &&
        media.length === voiceVideoSegments.length &&
        media.every((element, index) => element.type === voiceVideoSegments[index]!.type)
            ? { media, meta }
            : null;

    if (voiceVideoSegments.length > 0 && !voiceVideo) {
        log.warn('[get_msg] media metadata missing or inconsistent message_id=%d', messageId);
    }

    let voiceVideoIndex = 0;
    let changed = false;

    for (const [index, segment] of segments.entries()) {
        try {
            let url: string | null;

            if (segment.type === 'image') {
                const file =
                    typeof segment.data.file === 'string'
                        ? segment.data.file
                        : segment.data.file_id;

                if (typeof file !== 'string' || !file) {
                    continue;
                }

                url = await resolveImageUrl(
                    await ref.mediaStore.findImage(file),
                    ref.converterCtx.imageUrlResolver,
                );
            } else {
                if (!voiceVideo) {
                    continue;
                }

                const element = voiceVideo.media[voiceVideoIndex++]!;
                url = await resolveRemoteMediaUrl(
                    ref.bridge,
                    element.type,
                    element.mediaNode,
                    voiceVideo.meta.isGroup,
                    voiceVideo.meta.targetId,
                );
            }

            if (url && url !== segment.data.url) {
                segment.data.url = url;
                changed = true;
            }
        } catch (err) {
            // Refresh failure preserves this message's URL, never a different cached URL.
            log.warn(
                '[get_msg] media URL refresh failed message_id=%d type=%s media_index=%d: %s',
                messageId,
                segment.type,
                index,
                err instanceof Error ? err.message : String(err),
            );
        }
    }

    if (changed) {
        event.raw_message = segmentsToRawMessage(event.message);
    }
}

async function resolveImageUrl(
    cached: CachedImage | null,
    resolver?: ImageUrlResolver | null,
): Promise<string | null> {
    if (!cached?.imageUrl || !resolver) {
        return null;
    }

    return resolver(
        { type: 'image', imageUrl: cached.imageUrl, subType: cached.subType },
        cached.isGroup,
    );
}

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
    const event = await messageStore.findEvent(messageId);

    if (!event) {
        throw new Error('消息不存在或已被撤回');
    }

    const segments = Array.isArray(event.message) ? event.message : [];
    let file = '';

    for (const seg of segments) {
        if (typeof seg !== 'object' || seg === null || Array.isArray(seg)) {
            continue;
        }

        const so = seg as JsonObject;

        if (so.type !== 'record') {
            continue;
        }

        const data =
            typeof so.data === 'object' && so.data !== null && !Array.isArray(so.data)
                ? (so.data as JsonObject)
                : {};
        file = String(data.file ?? data.url ?? '');
        break;
    }

    if (!file) {
        throw new Error('消息中不包含语音');
    }

    const snapshot = (await messageStore.findMedia(messageId))?.find(
        (element) => element.type === 'record',
    );
    const cached = snapshot
        ? {
              ...snapshot,
              isGroup: event.message_type === 'group',
              sessionId: Number(event.group_id) || selfId,
          }
        : await mediaStore.findRecord(file, 'legacy');

    if (!cached) {
        throw new Error('语音不在缓存中，无法转写');
    }

    const isGroup = event.message_type === 'group' || cached.isGroup;
    const senderUin = Number(event.user_id) || 0;
    // c2c: receiver is self (inbound voice); group: the group uin.
    const peerUin = isGroup ? Number(event.group_id) || cached.sessionId : selfId;

    const text = await requestPttTransText(pttTransKey(selfId, messageId), 20_000, () =>
        bridge.apis.extras.translatePttToText({
            isGroup,
            msgId: messageId,
            senderUin,
            peerUin,
            uuid: cached.fileId || '',
            md5Hex: cached.md5Hex ?? '',
            duration: cached.duration ?? 0,
            size: cached.fileSize ?? 0,
            format: cached.voiceFormat ?? 0,
        }),
    );
    return { text };
}

export async function getImageInfo(
    mediaStore: MediaStore,
    file: string,
    imageUrlResolver?: ImageUrlResolver | null,
): Promise<JsonObject | null> {
    const cached = await mediaStore.findImage(file);

    if (!cached) {
        return null;
    }

    let url = cached.url || cached.imageUrl || '';

    try {
        const fresh = await resolveImageUrl(cached, imageUrlResolver);

        if (fresh) {
            url = fresh;
        }
    } catch (err) {
        log.warn(
            'get_image URL refresh failed: %s',
            err instanceof Error ? err.message : String(err),
        );
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
    const cached = await mediaStore.findRecord(file);

    if (!cached) {
        return null;
    }

    const url = await resolveRemoteMediaUrl(
        bridge,
        'record',
        cached.mediaNode,
        cached.isGroup,
        cached.sessionId,
    );
    await mediaStore.updateRecordUrl(file, url);
    return {
        file: url,
        url,
        file_size: String(cached.fileSize ?? 0),
        file_name: cached.fileName || cached.file,
    };
}
