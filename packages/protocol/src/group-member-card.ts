import { createLogger } from '@snowluma/common/logger';
import type { ResponseGrp, RichGroupCard } from '@snowluma/proto-defs/message';
import { protobuf_decode } from '@snowluma/proton';

const log = createLogger('Protocol.GroupMemberCard');
const utf8 = new TextDecoder('utf-8', { fatal: true });

/** Keep ordinary text whitespace, but never publish binary framing as a name. */
export function isBinaryCardText(text: string): boolean {
    // eslint-disable-next-line no-control-regex -- These are the binary framing bytes we must detect.
    return /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(text);
}

function displayText(bytes: Uint8Array): string {
    let text: string;

    try {
        text = utf8.decode(bytes);
    } catch (cause) {
        throw new Error('group card contains invalid UTF-8', { cause });
    }

    if (isBinaryCardText(text)) {
        throw new Error('group card text contains binary control characters');
    }

    return text;
}

export function decodeGroupMemberCard(bytes?: Uint8Array): string {
    if (!bytes?.length) {
        return '';
    }

    // Each part has tag 0x0a, but version/unknown fields can precede the parts.
    if (!bytes.includes(0x0a)) {
        return displayText(bytes);
    }

    let parts: RichGroupCard['parts'];

    try {
        parts = protobuf_decode<RichGroupCard>(bytes).parts;
    } catch {
        // Both formats occupy the same wire field. A newline in a plain name
        // is also 0x0a; accept it only if the entire value is valid display text.
        return displayText(bytes);
    }

    if (!parts?.length) {
        return displayText(bytes);
    }

    // A control field, even an empty one, takes precedence over text in the same part.
    const text = parts.flatMap((part) =>
        part.control == null && part.text != null ? [part.text] : [],
    );
    return displayText(Buffer.concat(text));
}

/** A malformed optional display name must not discard the message itself. */
export function decodeGroupDisplayName(group?: ResponseGrp): string | undefined {
    if (!group?.memberCard?.length) {
        return undefined;
    }

    const bytes = group.memberCard;

    try {
        return group.memberCardType === 2 ? displayText(bytes) : decodeGroupMemberCard(bytes);
    } catch (error) {
        log.warn(
            'invalid group message display name: group=%d bytes=%d reason=%s',
            group.groupUin ?? 0,
            bytes.length,
            error instanceof Error ? error.message : String(error),
        );
        return undefined;
    }
}
