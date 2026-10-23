import type { AnyMessageSegment, OutgoingMessage } from '../types/index.js';
import { normalizeMessage } from './chain.js';
import { parseSegments } from './cq.js';
import { segments } from './segments.js';

/** Adds an existing message's ID as the quote without changing the supplied body. */
export function quoteMessage(
    messageId: number,
    message: OutgoingMessage,
    options: { autoEscape?: boolean } = {},
): string | AnyMessageSegment[] {
    if (
        !Number.isInteger(messageId) ||
        messageId === 0 ||
        messageId < -2147483648 ||
        messageId > 2147483647
    ) {
        throw new TypeError('quoteMessage() requires a non-zero signed 32-bit message ID');
    }

    const normalized = normalizeMessage(message);
    const quote = segments.reply(messageId);

    if (typeof normalized === 'string') {
        if (options.autoEscape) {
            return [quote, segments.text(normalized)];
        }

        assertNoReply(parseSegments(normalized));
        // Keep the original CQ body so extension fields are not lost in conversion.
        return `[CQ:reply,id=${messageId}]${normalized}`;
    }

    assertNoReply(normalized);
    return [quote, ...normalized];
}

function assertNoReply(message: AnyMessageSegment[]): void {
    if (message.some((segment) => segment.type === 'reply')) {
        throw new TypeError('quoteMessage() cannot add a quote to a message containing a reply');
    }
}
