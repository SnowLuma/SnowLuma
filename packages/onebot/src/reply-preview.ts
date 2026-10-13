import type { MessageElement } from '@snowluma/protocol/events';
import { MessageElementValidationError } from '@snowluma/protocol/element-manifest';

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
    markdown: '[Markdown]',
};

function previewLabel(type: string): string {
    if (!Object.hasOwn(labels, type)) {
        throw new MessageElementValidationError(
            'UNSENDABLE_TYPE',
            `message segment "${type}" is not supported in a reply preview`,
            type,
        );
    }

    return labels[type]!;
}

export function assertReplyPreviewType(type: string): void {
    if (type !== 'text' && type !== 'at') {
        previewLabel(type);
    }
}

/** Quotes carry display text; media must not be uploaded again for a preview. */
export function elementsToReplyPreview(elements: readonly MessageElement[]): MessageElement[] {
    const text = elements
        .map((element) => {
            if (element.type === 'text') {
                return element.text;
            }

            if (element.type === 'at') {
                return element.targetUin === 0 ? '@全体成员' : `@${element.targetUin}`;
            }

            return previewLabel(element.type);
        })
        .join('');
    return [{ type: 'text', text }];
}

export function replyPreviewElements(message: unknown): MessageElement[] {
    if (!Array.isArray(message)) {
        return [];
    }

    const parts: string[] = [];

    for (const segment of message) {
        if (!segment || typeof segment !== 'object') {
            continue;
        }

        const data = segment.data;

        if (!data || typeof data !== 'object') {
            continue;
        }

        if (segment.type === 'text' && typeof data.text === 'string') {
            parts.push(data.text);
        } else if (segment.type === 'at') {
            parts.push(data.qq === 'all' ? '@全体成员' : `@${data.qq ?? ''}`);
        } else if (typeof segment.type === 'string' && Object.hasOwn(labels, segment.type)) {
            parts.push(labels[segment.type]!);
        }
    }

    const text = parts.join('');
    return text ? [{ type: 'text', text }] : [];
}
