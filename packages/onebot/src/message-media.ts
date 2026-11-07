import type { MessageElement } from '@snowluma/protocol/events';
import { serializeMediaInfo } from './media-store';
import type { JsonObject, JsonValue } from './types';

export type MessageMedia = Extract<MessageElement, { type: 'image' | 'record' | 'video' }>;
export type StoredMediaSegment = JsonObject & { type: MessageMedia['type']; data: JsonObject };

export function isStoredMediaSegment(segment: JsonValue): segment is StoredMediaSegment {
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

/** Legacy image segments use a content hash filename; arbitrary aliases prove nothing. */
export function imageMd5FromFile(file: unknown): string | undefined {
    return typeof file === 'string'
        ? /^([a-f0-9]{32})\.(?:png|jpe?g|webp|gif|bmp)$/i.exec(file)?.[1]?.toLowerCase()
        : undefined;
}

const mediaSnapshot = Symbol('message media snapshot');
type MediaSegment = JsonObject & { [mediaSnapshot]?: MessageMedia };

/** Snapshot queued writes, including metadata that is deliberately absent from JSON. */
export function snapshotMessageEvent(event: JsonObject): JsonObject {
    const snapshot = structuredClone(event);

    if (Array.isArray(event.message) && Array.isArray(snapshot.message)) {
        for (const [index, segment] of event.message.entries()) {
            if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
                continue;
            }

            const media = (segment as MediaSegment)[mediaSnapshot];
            const copied = snapshot.message[index];

            if (media && copied && typeof copied === 'object') {
                Object.defineProperty(copied, mediaSnapshot, { value: structuredClone(media) });
            }
        }
    }

    return snapshot;
}

export function isMessageMedia(element: MessageElement): element is MessageMedia {
    return element.type === 'image' || element.type === 'record' || element.type === 'video';
}

/** Keep persistence-only metadata beside the converted segment, never on the
 * public JSON wire. Capture after successful conversion so skipped elements
 * cannot shift the association between a message and its media snapshots.
 */
export function attachMessageMedia(segment: JsonObject, element: MessageElement): void {
    if (!isMessageMedia(element)) {
        return;
    }

    const {
        type,
        fileId,
        fileName,
        fileSize,
        url,
        imageUrl,
        md5Hex,
        sha1Hex,
        subType,
        summary,
        width,
        height,
        picFormat,
        duration,
        voiceFormat,
        videoFormat,
        fileHash,
        mediaNode,
        flash,
    } = element;
    const snapshot = JSON.parse(
        serializeMediaInfo({
            type,
            fileId,
            fileName,
            fileSize,
            url,
            imageUrl,
            md5Hex,
            sha1Hex,
            subType,
            summary,
            width,
            height,
            picFormat,
            duration,
            voiceFormat,
            videoFormat,
            fileHash,
            mediaNode,
            flash,
        }),
    ) as MessageMedia;
    Object.defineProperty(segment, mediaSnapshot, { value: snapshot });
}

export function serializeMessageMedia(event: JsonObject): string | null {
    if (!Array.isArray(event.message)) {
        return null;
    }

    const snapshots = event.message.flatMap((segment) => {
        if (!segment || typeof segment !== 'object' || Array.isArray(segment)) {
            return [];
        }

        const snapshot = (segment as MediaSegment)[mediaSnapshot];
        return snapshot ? [snapshot] : [];
    });
    return snapshots.length > 0 ? JSON.stringify(snapshots) : null;
}

export function parseMessageMedia(data: string): MessageMedia[] {
    const parsed: unknown = JSON.parse(data);

    if (
        !Array.isArray(parsed) ||
        parsed.some(
            (value) =>
                !value ||
                typeof value !== 'object' ||
                !['image', 'record', 'video'].includes(value.type),
        )
    ) {
        throw new Error('invalid persisted message media metadata');
    }

    return parsed as MessageMedia[];
}

/** A repeated server representation may omit fields already learned from an
 * upload or earlier receive. Preserve those fields only for the same resource;
 * conflicting fingerprints or uncertain associations must not rewrite history.
 */
export function mergeMessageMedia(previous: string | null, next: string | null): string | null {
    if (!previous) {
        return next;
    }

    if (previous === next) {
        return previous;
    }

    if (!next) {
        throw new Error('message update is missing previously stored media metadata');
    }

    const oldMedia = parseMessageMedia(previous);
    const newMedia = parseMessageMedia(next);

    if (oldMedia.length !== newMedia.length) {
        throw new Error('message media association changed');
    }

    const merged = newMedia.map((media, index) => {
        const old = oldMedia[index]!;

        if (old.type !== media.type) {
            throw new Error('message media association changed');
        }

        let matched = false;

        for (const field of ['md5Hex', 'sha1Hex'] as const) {
            if (!old[field] || !media[field]) {
                continue;
            }

            if (old[field].toLowerCase() !== media[field].toLowerCase()) {
                throw new Error('message update has conflicting media fingerprints');
            }

            matched = true;
        }

        // Images can expose a filename as fileId, so only their fingerprints can
        // prove an association. Voice/video fileId is a source resource UUID.
        matched ||= media.type !== 'image' && !!old.fileId && old.fileId === media.fileId;

        if (!matched && JSON.stringify(old) !== JSON.stringify(media)) {
            throw new Error('message update has an unverified media association');
        }

        return mergeKnownMediaFields(old, media);
    });
    return JSON.stringify(merged);
}

function mergeKnownMediaFields(old: object, next: object): Record<string, unknown> {
    const merged: Record<string, unknown> = { ...old };

    for (const [key, value] of Object.entries(next)) {
        // Zero dimensions, sizes and durations are incomplete observations, not
        // evidence that known properties of the same resource have changed.
        if (value === undefined || value === null || value === '' || value === 0) {
            continue;
        }

        const previous = merged[key];
        merged[key] =
            typeof value === 'object' &&
            !Array.isArray(value) &&
            previous !== null &&
            typeof previous === 'object' &&
            !Array.isArray(previous)
                ? mergeKnownMediaFields(previous, value)
                : value;
    }

    return merged;
}
