import type { MessageIdResolver } from './event-converter';
import type { MessageStore } from './message-store';
import {
    GROUP_MESSAGE_EVENT,
    PRIVATE_MESSAGE_EVENT,
    PRIVATE_NT_MESSAGE_EVENT,
    PRIVATE_SENT_MESSAGE_EVENT,
    hashMessageIdInt32,
} from './message-id';

export function createMessageIdResolver(
    store: Pick<MessageStore, 'resolvePrivateReplyMessageId'>,
): MessageIdResolver {
    return async (
        isGroup,
        sessionId,
        sequence,
        eventName,
        timestamp,
        replyElements,
        excludedMessage,
    ) => {
        const resolvedEventName =
            eventName || (isGroup ? GROUP_MESSAGE_EVENT : PRIVATE_MESSAGE_EVENT);

        if (
            !isGroup &&
            timestamp !== undefined &&
            (resolvedEventName === PRIVATE_MESSAGE_EVENT ||
                resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT)
        ) {
            const storedId = await store.resolvePrivateReplyMessageId(
                sessionId,
                sequence,
                resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT,
                timestamp,
                replyElements,
                excludedMessage,
            );

            // Quote sequences are not canonical message-id inputs. A miss must
            // remain unresolved so the live pipeline can fetch and verify history.
            return storedId ?? 0;
        }

        return hashMessageIdInt32(
            sequence,
            sessionId,
            resolvedEventName === PRIVATE_SENT_MESSAGE_EVENT
                ? PRIVATE_NT_MESSAGE_EVENT
                : resolvedEventName,
        );
    };
}
