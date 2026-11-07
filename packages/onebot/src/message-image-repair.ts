import { createLogger } from '@snowluma/common/logger';
import type { FriendMessage, GroupMessage, MessageElementOf } from '@snowluma/protocol/events';
import type { OneBotInstanceContext } from './instance-context';
import { segmentsToRawMessage } from './helper/cq';
import {
    attachMessageMedia,
    imageMd5FromFile,
    isStoredMediaSegment,
    type MessageMedia,
    type StoredMediaSegment,
} from './message-media';
import { PRIVATE_QUOTE_MAX_DRIFT_SECONDS } from './private-quote';
import { hasAuthoritativeSequence, type JsonObject, type MessageMeta } from './types';

const log = createLogger('OneBot');
type RepairContext = Pick<OneBotInstanceContext, 'selfId' | 'bridge' | 'messageStore'>;
type HistoryMessage = FriendMessage | GroupMessage;

function remoteUrl(value: unknown): value is string {
    return typeof value === 'string' && /^https?:\/\//i.test(value);
}

function imageReference(element: MessageMedia | undefined): string {
    return remoteUrl(element?.imageUrl)
        ? element.imageUrl
        : remoteUrl(element?.url)
          ? element.url
          : '';
}

/** Repair only missing image references. Full server events must not replace the
 * original message body, sender classification, signed id or sequence metadata.
 */
export async function readMessageWithImageRepair(
    ref: RepairContext,
    messageId: number,
): Promise<JsonObject | null> {
    const event = await ref.messageStore.findEvent(messageId);

    if (!event || !Array.isArray(event.message)) {
        return event;
    }

    const segments = event.message.filter(isStoredMediaSegment);

    if (!segments.some((segment) => segment.type === 'image' && !remoteUrl(segment.data.url))) {
        return event;
    }

    try {
        const media = await ref.messageStore.findMedia(messageId);

        if (
            media &&
            (media.length !== segments.length ||
                media.some((element, index) => element.type !== segments[index]!.type))
        ) {
            throw new Error('stored media association is inconsistent');
        }

        const missing = segments.map(
            (segment, index) =>
                segment.type === 'image' &&
                !remoteUrl(segment.data.url) &&
                !imageReference(media?.[index]),
        );

        if (!missing.some(Boolean)) {
            return event;
        }

        const storedMeta = await ref.messageStore.findMeta(messageId);
        // As in private history listing, old self-keyed outgoing rows require
        // their explicit recipient. This changes lookup scope, never stored identity.
        const meta =
            storedMeta &&
            !storedMeta.isGroup &&
            storedMeta.targetId === ref.selfId &&
            event.user_id === ref.selfId &&
            typeof event.target_id === 'number' &&
            Number.isSafeInteger(event.target_id) &&
            event.target_id > 0
                ? { ...storedMeta, targetId: event.target_id }
                : storedMeta;

        if (
            !meta ||
            meta.targetId <= 0 ||
            meta.timestamp <= 0 ||
            !Number.isSafeInteger(event.user_id) ||
            Number(event.user_id) <= 0 ||
            (event.self_id !== undefined && event.self_id !== ref.selfId) ||
            event.message_type !== (meta.isGroup ? 'group' : 'private') ||
            (meta.isGroup ? event.group_id !== meta.targetId : event.sub_type !== 'friend') ||
            (!meta.isGroup && event.target_id !== undefined && event.target_id !== meta.targetId)
        ) {
            throw new Error('stored message identity is incomplete');
        }

        const candidates = (await fetchHistory(ref, meta)).filter((source) =>
            matchesIdentity(source, event, meta, ref.selfId),
        );

        if (candidates.length !== 1) {
            throw new Error(`expected one matching history message, got ${candidates.length}`);
        }

        const images = candidates[0]!.elements.filter(
            (element): element is MessageElementOf<'image'> => element.type === 'image',
        );
        const storedImages = segments.filter((segment) => segment.type === 'image');

        if (images.length !== storedImages.length) {
            throw new Error('history image count differs from stored message');
        }

        const updated = structuredClone(event);
        const updatedSegments = (updated.message as JsonObject[]).filter(isStoredMediaSegment);
        // Never create empty placeholders for other media: they would prevent
        // a later complete history response from filling their real metadata.
        const attachSnapshots =
            media !== null || segments.every((segment) => segment.type === 'image');
        let imageIndex = 0;

        for (const [index, segment] of updatedSegments.entries()) {
            const old = media?.[index];
            let element: MessageMedia = old ?? { type: segment.type };

            if (segment.type === 'image') {
                const image = images[imageIndex++]!;
                verifyImage(old, segment, image);

                if (missing[index]) {
                    const url = imageReference(image);

                    if (!url) {
                        throw new Error('history image has no download reference');
                    }

                    element = { ...image, imageUrl: url };
                    segment.data.url = url;
                } else if (!old) {
                    element = { ...image, imageUrl: String(segment.data.url) };
                }
            }

            if (attachSnapshots) {
                attachMessageMedia(segment, element);
            }
        }

        updated.raw_message = segmentsToRawMessage(updated.message as JsonObject[]);

        if (!(await ref.messageStore.updateMedia(messageId, event, updated))) {
            log.debug(
                '[get_msg] image history repair skipped after concurrent update message_id=%d',
                messageId,
            );
            return ref.messageStore.findEvent(messageId);
        }

        log.debug(
            '[get_msg] image history repair saved message_id=%d images=%d',
            messageId,
            missing.filter(Boolean).length,
        );
        return updated;
    } catch (error) {
        // get_msg retains its documented partial-media behavior; do not invent
        // a URL or overwrite a record when history cannot prove the association.
        log.warn(
            '[get_msg] image history repair failed message_id=%d: %s',
            messageId,
            error instanceof Error ? error.message : String(error),
        );
        return ref.messageStore.findEvent(messageId);
    }
}

async function fetchHistory(ref: RepairContext, meta: MessageMeta): Promise<HistoryMessage[]> {
    if (meta.isGroup) {
        if (!hasAuthoritativeSequence(meta)) {
            throw new Error('group message has no verified sequence');
        }

        const message = await ref.bridge.apis.message.getGroupMessageBySeq(
            meta.targetId,
            meta.sequence,
            ref.selfId,
        );
        return message ? [message] : [];
    }

    const uid = await ref.bridge.resolveUserUid(meta.targetId);

    if (!uid) {
        throw new Error('private history peer could not be resolved');
    }

    if (meta.sequenceAuthoritative && Number.isSafeInteger(meta.sequence) && meta.sequence > 0) {
        const message = await ref.bridge.apis.message.getC2cMessageBySeq(
            uid,
            meta.sequence,
            ref.selfId,
        );
        return message ? [message] : [];
    }

    if (meta.clientSequence <= 0) {
        throw new Error('private message has no verified client sequence');
    }

    return ref.bridge.apis.message.getC2cLatestHistory(
        uid,
        20,
        ref.selfId,
        Math.min(0xffff_ffff, meta.timestamp + 1),
    );
}

function matchesIdentity(
    source: HistoryMessage,
    event: JsonObject,
    meta: MessageMeta,
    selfId: number,
): boolean {
    if (
        source.selfUin !== selfId ||
        source.senderUin !== event.user_id ||
        !Number.isSafeInteger(source.time) ||
        source.time <= 0 ||
        Math.abs(source.time - meta.timestamp) > PRIVATE_QUOTE_MAX_DRIFT_SECONDS
    ) {
        return false;
    }

    if (source.kind === 'group_message') {
        return meta.isGroup && source.groupId === meta.targetId && source.msgSeq === meta.sequence;
    }

    // These history requests explicitly bind the peer UID. Older outgoing
    // responses can omit toUin; preserve that binding, never substitute selfId.
    const peer = source.peerUin ?? (source.senderUin !== selfId ? source.senderUin : meta.targetId);

    if (
        meta.isGroup ||
        peer !== meta.targetId ||
        (meta.privateDirection &&
            (source.senderUin === selfId) !== (meta.privateDirection === 'outgoing'))
    ) {
        return false;
    }

    return meta.sequenceAuthoritative && Number.isSafeInteger(meta.sequence) && meta.sequence > 0
        ? source.sequenceAuthoritative !== false && source.ntMsgSeq === meta.sequence
        : (source.clientSeq ?? source.msgSeq) === meta.clientSequence;
}

function verifyImage(
    old: MessageMedia | undefined,
    segment: StoredMediaSegment,
    image: MessageElementOf<'image'>,
): void {
    // Older rows lack per-message snapshots but expose the content hash as the
    // image filename. Arbitrary aliases cannot establish this association.
    const legacyMd5 = imageMd5FromFile(segment.data.file ?? segment.data.file_id);
    const fingerprints = { md5Hex: old?.md5Hex || legacyMd5, sha1Hex: old?.sha1Hex };
    let matched = false;

    for (const field of ['md5Hex', 'sha1Hex'] as const) {
        const before = fingerprints[field];
        const after = image[field];

        if (!before || !after) {
            continue;
        }

        if (before.toLowerCase() !== after.toLowerCase()) {
            throw new Error('history image fingerprint conflicts with stored message');
        }

        matched = true;
    }

    if (!matched) {
        throw new Error('history image fingerprint cannot be verified');
    }
}
