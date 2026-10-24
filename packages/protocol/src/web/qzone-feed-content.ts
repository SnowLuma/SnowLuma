import { DomUtils, parseDocument } from 'htmlparser2';

type Element = ReturnType<typeof DomUtils.findAll>[number];
type Node = ReturnType<typeof parseDocument>['children'][number];

export interface QzoneFeedContent {
    tid: string | null;
    content: string | null;
    content_complete: boolean | null;
    images: string[] | null;
    like_count: number | null;
    comment_count: number | null;
}

function hasClass(node: Element, name: string): boolean {
    return (node.attribs.class ?? '').split(/\s+/).includes(name);
}

function isContentNode(node: Element, root: Element): boolean {
    for (let parent = node.parent; parent && parent !== root; parent = parent.parent) {
        if (
            'attribs' in parent &&
            (hasClass(parent, 'mod-comments') ||
                hasClass(parent, 'comments-list') ||
                hasClass(parent, 'f-item-passive') ||
                hasClass(parent, 'f-ct-video'))
        ) {
            return false;
        }
    }

    return true;
}

function text(node: Element): string {
    const chunks: string[] = [];
    const stack: (Node | string)[] = [...node.children].reverse();

    while (stack.length) {
        const next = stack.pop()!;

        if (typeof next === 'string') {
            chunks.push(next);
        } else if (next.type === 'text') {
            chunks.push(next.data.replace(/\s+/g, ' '));
        } else if (next.type === 'tag') {
            if (next.attribs['data-cmd'] === 'qz_toggle' || hasClass(next, 'load_img')) {
                continue;
            }

            if (next.name === 'br') {
                chunks.push('\n');
            } else if (next.name === 'img') {
                chunks.push(next.attribs.alt ?? '');
            } else {
                if (['div', 'p', 'li'].includes(next.name)) {
                    chunks.push('\n');
                    stack.push('\n');
                }

                for (let i = next.children.length - 1; i >= 0; i--) {
                    stack.push(next.children[i]);
                }
            }
        }
    }

    return chunks
        .join('')
        .replace(/ *\n */g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();
}

function count(value: unknown): number | null {
    if (typeof value !== 'number' && (typeof value !== 'string' || !/^\d+$/.test(value))) {
        return null;
    }

    const number = Number(value);
    return Number.isSafeInteger(number) && number >= 0 ? number : null;
}

function imageUrl(value: string | undefined): string | null {
    if (!value) {
        return null;
    }

    try {
        const url = new URL(value.startsWith('//') ? `https:${value}` : value);
        return url.protocol === 'http:' || url.protocol === 'https:' ? url.href : null;
    } catch {
        return null;
    }
}

/** Extract only the post's own content; comments, avatars and video covers are separate. */
export function parseQzoneFeedContent(
    html: string,
    key: string,
    uin: number,
    appid: number,
    likeCount?: unknown,
    commentCount?: unknown,
): QzoneFeedContent {
    const doc = parseDocument(html);
    const elements = DomUtils.findAll(() => true, doc.children);
    const body = elements.find(
        (node) => hasClass(node, 'f-item') && node.attribs['data-key'] === key,
    );
    const result: QzoneFeedContent = {
        tid: null,
        content: null,
        content_complete: null,
        images: null,
        like_count: count(likeCount),
        comment_count: count(commentCount),
    };

    if (!body) {
        return result;
    }

    let root = body;

    for (let parent = body.parent; parent && 'attribs' in parent; parent = parent.parent) {
        if (hasClass(parent, 'f-single')) {
            root = parent;
            break;
        }
    }

    const bodyElements = DomUtils.findAll((node) => isContentNode(node, body), body.children);
    const metadata = bodyElements.find(
        (node) =>
            node.attribs.name === 'feed_data' &&
            node.attribs['data-uin'] === String(uin) &&
            node.attribs['data-fkey'] === key,
    );

    if (appid === 311 && metadata?.attribs['data-tid']) {
        result.tid = metadata.attribs['data-tid'];
    }

    const contentNodes = bodyElements.filter((node) => hasClass(node, 'f-info'));
    const complete = contentNodes.find(
        (node) => hasClass(node, 'qz_info_complete') && text(node) !== '',
    );
    const content = complete ?? contentNodes.find((node) => !hasClass(node, 'qz_info_complete'));

    if (content) {
        result.content = text(content);
        result.content_complete =
            !!complete ||
            !DomUtils.findAll((node) => node.attribs['data-cmd'] === 'qz_toggle', content.children)
                .length;
    }

    const images = new Set<string>();

    for (const item of bodyElements.filter((node) => hasClass(node, 'img-item'))) {
        if (item.attribs['data-v_itemid'] || item.attribs['data-videotype']) {
            continue;
        }

        const full = imageUrl(item.attribs['data-originurl'] ?? item.attribs['data-url3']);

        if (full) {
            images.add(full);
            continue;
        }

        for (const image of DomUtils.findAll((node) => node.name === 'img', item.children)) {
            const url = imageUrl(image.attribs.truesrc ?? image.attribs.src);

            if (url) {
                images.add(url);
            }
        }
    }

    result.images = [...images];
    const like = DomUtils.findAll(
        (node) => hasClass(node, 'qz_like_btn_v3') && isContentNode(node, root),
        root.children,
    )[0];
    result.like_count ??= count(like?.attribs['data-likecnt']);
    return result;
}
