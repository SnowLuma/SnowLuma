import type { MessageElement } from '@snowluma/protocol/events';
import type { JsonObject } from './types';
import { cqUnescape } from './helper/cq';

// Send receipts and quoted timestamps can differ; never search outside the
// existing bounded drift window when resolving a quoted message.
export const PRIVATE_QUOTE_MAX_DRIFT_SECONDS = 30;
const TIME_WINDOWS = [0, 5, PRIVATE_QUOTE_MAX_DRIFT_SECONDS] as const;

interface QuotePreview {
    text: string;
    plain: boolean;
}

export interface PrivateQuoteCandidate {
    id?: number;
    sequence: number;
    clientSequence: number;
    timestamp: number;
    preview: QuotePreview | null;
}

/** Identity of the containing message, which can never be its own quote target. */
export interface PrivateQuoteSource {
    id: number;
    sequence: number;
    clientSequence: number;
    timestamp: number;
    sentBySelf: boolean;
}

export interface PrivateQuoteKey {
    sequence: number;
    sentBySelf: boolean;
    timestamp?: number;
    elements?: readonly MessageElement[];
    exclude?: PrivateQuoteSource;
}

export function isUsableQuoteTime(timestamp: number | undefined): timestamp is number {
    return (
        timestamp !== undefined &&
        Number.isSafeInteger(timestamp) &&
        timestamp > 0 &&
        timestamp < Number.MAX_SAFE_INTEGER
    );
}

/** Sequence namespaces may overlap. Only a unique, consistent candidate wins. */
export function selectPrivateQuote<T extends PrivateQuoteCandidate>(
    candidates: readonly T[],
    quote: PrivateQuoteKey,
): { candidate: T | null; reason: 'sequence' | 'time' | 'ambiguous' | 'missing' } {
    const time = isUsableQuoteTime(quote.timestamp) ? quote.timestamp : null;
    const text =
        quote.elements?.length && quote.elements.every((element) => element.type === 'text')
            ? quote.elements.map((element) => element.text ?? '').join('')
            : '';
    const nearby = candidates.filter((candidate) => {
        const source = quote.exclude;

        if (
            source &&
            (candidate.id === source.id ||
                (source.sentBySelf === quote.sentBySelf &&
                    ((source.sequence > 0 && candidate.sequence === source.sequence) ||
                        (source.clientSequence > 0 &&
                            candidate.clientSequence === source.clientSequence &&
                            candidate.timestamp === source.timestamp))))
        ) {
            return false;
        }

        return (
            time === null || Math.abs(candidate.timestamp - time) <= PRIVATE_QUOTE_MAX_DRIFT_SECONDS
        );
    });
    // QQ can truncate the quote. Unknown and prefix-only previews remain
    // competing candidates; only contradictory known content is excluded.
    const compatible = nearby.filter(
        (candidate) => !text || !candidate.preview || candidate.preview.text.startsWith(text),
    );
    const bySequence = compatible.filter(
        (candidate) =>
            quote.sequence > 0 &&
            (candidate.clientSequence === quote.sequence || candidate.sequence === quote.sequence),
    );

    if (bySequence.length > 0) {
        return {
            candidate: bySequence.length === 1 ? bySequence[0]! : null,
            reason: bySequence.length === 1 ? 'sequence' : 'ambiguous',
        };
    }

    if (quote.sentBySelf && time !== null) {
        for (const window of TIME_WINDOWS) {
            const matches = compatible.filter(
                (candidate) => Math.abs(candidate.timestamp - time) <= window,
            );

            if (matches.length > 0) {
                const match = matches.length === 1 ? matches[0]! : null;
                const windowCount = nearby.filter(
                    (candidate) => Math.abs(candidate.timestamp - time) <= window,
                ).length;
                // A missing body cannot confirm quoted text. When content is the
                // only discriminator, a truncated/media preview cannot prove it.
                const confirmed =
                    match &&
                    (!text ||
                        (match.preview &&
                            (windowCount === 1 ||
                                (match.preview.plain && match.preview.text === text))));
                return {
                    candidate: confirmed ? match : null,
                    reason: confirmed ? 'time' : 'ambiguous',
                };
            }
        }
    }

    return { candidate: null, reason: 'missing' };
}

const labels: Readonly<Record<string, string>> = {
    image: '[图片]',
    record: '[语音]',
    video: '[视频]',
    file: '[文件]',
    face: '[表情]',
    mface: '[表情]',
    forward: '[聊天记录]',
    json: '[卡片]',
    xml: '[卡片]',
};

export function cachedQuotePreview(data: string | null): QuotePreview | null {
    if (!data) {
        return null;
    }

    const event = JSON.parse(data) as JsonObject;

    if (typeof event.message === 'string') {
        return event.message.includes('[CQ:')
            ? null
            : { text: cqUnescape(event.message), plain: true };
    }

    if (!Array.isArray(event.message) || event.message.length === 0) {
        return null;
    }

    const parts: string[] = [];
    let plain = true;

    for (const segment of event.message as JsonObject[]) {
        const body = segment?.data as JsonObject | undefined;

        if (segment?.type === 'text' && typeof body?.text === 'string') {
            parts.push(body.text);
        } else if (typeof segment?.type === 'string' && Object.hasOwn(labels, segment.type)) {
            parts.push(typeof body?.summary === 'string' ? body.summary : labels[segment.type]!);
            plain = false;
        } else {
            return null;
        }
    }

    return { text: parts.join(''), plain };
}

export function messageQuotePreview(elements: readonly MessageElement[]): QuotePreview | null {
    const parts: string[] = [];
    let plain = true;

    for (const element of elements) {
        if (element.type === 'text') {
            parts.push(element.text ?? '');
        } else if (Object.hasOwn(labels, element.type)) {
            parts.push(
                'summary' in element && typeof element.summary === 'string'
                    ? element.summary
                    : labels[element.type]!,
            );
            plain = false;
        } else {
            return null;
        }
    }

    return parts.length > 0 ? { text: parts.join(''), plain } : null;
}
