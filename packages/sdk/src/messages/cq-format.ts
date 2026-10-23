import type { AnyMessageSegment } from '../types/index.js';

export function escapeCqText(text: string): string {
    return text.replaceAll('&', '&amp;').replaceAll('[', '&#91;').replaceAll(']', '&#93;');
}

export function escapeCqParam(text: string): string {
    return escapeCqText(text).replaceAll(',', '&#44;');
}

export function segmentsToCQString(segments: AnyMessageSegment[]): string {
    return segments.map(segmentToCq).join('');
}

function segmentToCq(segment: AnyMessageSegment): string {
    if (segment.type === 'text') {
        return escapeCqText(String(segment.data.text ?? ''));
    }

    if (
        segment.type === 'reply' &&
        segment.data.message !== undefined &&
        typeof segment.data.message !== 'string'
    ) {
        throw new TypeError('reply.message containing message segments must be sent as JSON');
    }

    const params = Object.entries(segment.data)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${escapeCqParam(String(value))}`)
        .join(',');

    return params ? `[CQ:${segment.type},${params}]` : `[CQ:${segment.type}]`;
}
