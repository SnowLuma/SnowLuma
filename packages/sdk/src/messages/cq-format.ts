import type { KnownMessageSegment, MessageSegment } from '../types/index';

export function escapeCqText(text: string): string {
    return text.replace(/&/g, '&amp;').replace(/\[/g, '&#91;').replace(/\]/g, '&#93;');
}

export function escapeCqParam(text: string): string {
    return escapeCqText(text).replace(/,/g, '&#44;');
}

export function segmentsToCQString(segments: Array<KnownMessageSegment | MessageSegment>): string {
    return segments.map(segmentToCq).join('');
}

function segmentToCq(segment: KnownMessageSegment | MessageSegment): string {
    if (segment.type === 'text') {
        return escapeCqText(String(segment.data.text ?? ''));
    }

    const params = Object.entries(segment.data)
        .filter(([, value]) => value !== undefined && value !== null)
        .map(([key, value]) => `${key}=${escapeCqParam(String(value))}`)
        .join(',');

    return params ? `[CQ:${segment.type},${params}]` : `[CQ:${segment.type}]`;
}
