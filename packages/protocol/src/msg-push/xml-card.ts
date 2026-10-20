const NAME_START =
    ':A-Z_a-z\\u00C0-\\u00D6\\u00D8-\\u00F6\\u00F8-\\u02FF\\u0370-\\u037D' +
    '\\u037F-\\u1FFF\\u200C-\\u200D\\u2070-\\u218F\\u2C00-\\u2FEF\\u3001-\\uD7FF' +
    '\\uF900-\\uFDCF\\uFDF0-\\uFFFD\\u{10000}-\\u{EFFFF}';
const ATTRIBUTE = new RegExp(
    `([${NAME_START}][\\u0300-\\u036F${NAME_START}\\-.0-9\\u00B7\\u203F-\\u2040]*)` +
        `[\\t\\r\\n ]*=[\\t\\r\\n ]*(?:"([^"<]*)"|'([^'<]*)')`,
    'uy',
);
const SPACE = /[\t\r\n ]*/y;
const ENTITIES = new Map([
    ['amp', '&'],
    ['lt', '<'],
    ['gt', '>'],
    ['quot', '"'],
    ['apos', "'"],
]);

function decodeAttribute(value: string): string | undefined {
    let valid = true;
    // Literal whitespace is normalized before expanding character references.
    const decoded = value
        .replace(/\r\n|[\t\r\n]/g, ' ')
        .replace(
            /&(#x[0-9a-fA-F]+|#[0-9]+|amp|lt|gt|quot|apos);|&/g,
            (_match, entity: string | undefined) => {
                const named = entity === undefined ? undefined : ENTITIES.get(entity);

                if (named !== undefined) {
                    return named;
                }

                if (entity?.startsWith('#')) {
                    const code = entity.startsWith('#x')
                        ? Number.parseInt(entity.slice(2), 16)
                        : Number.parseInt(entity.slice(1), 10);

                    if (
                        code === 9 ||
                        code === 10 ||
                        code === 13 ||
                        (code >= 0x20 && code <= 0xd7ff) ||
                        (code >= 0xe000 && code <= 0xfffd) ||
                        (code >= 0x10000 && code <= 0x10ffff)
                    ) {
                        return String.fromCodePoint(code);
                    }
                }

                valid = false;
                return '';
            },
        );
    return valid ? decoded : undefined;
}

/** Read the first element's attributes without searching comments, values or descendants. */
export function readXmlMsgAttributes(content: string): ReadonlyMap<string, string> | undefined {
    let cursor = content.startsWith('\uFEFF') ? 1 : 0;

    for (;;) {
        SPACE.lastIndex = cursor;
        SPACE.exec(content);
        cursor = SPACE.lastIndex;
        const closing = content.startsWith('<!--', cursor)
            ? '-->'
            : content.startsWith('<?', cursor)
              ? '?>'
              : undefined;

        if (!closing) {
            break;
        }

        const end = content.indexOf(closing, cursor + (closing === '-->' ? 4 : 2));

        if (end < 0) {
            return undefined;
        }

        cursor = end + closing.length;
    }

    if (!content.startsWith('<msg', cursor)) {
        return undefined;
    }

    cursor += 4;
    const attributes = new Map<string, string>();

    for (;;) {
        const beforeSpace = cursor;
        SPACE.lastIndex = cursor;
        SPACE.exec(content);
        cursor = SPACE.lastIndex;

        if (content[cursor] === '>' || content.startsWith('/>', cursor)) {
            return attributes;
        }

        if (cursor === beforeSpace) {
            return undefined;
        }

        ATTRIBUTE.lastIndex = cursor;
        const match = ATTRIBUTE.exec(content);

        if (!match || attributes.has(match[1]!)) {
            return undefined;
        }

        const value = decodeAttribute(match[2] ?? match[3]!);

        if (value === undefined) {
            return undefined;
        }

        attributes.set(match[1]!, value);
        cursor = ATTRIBUTE.lastIndex;
    }
}
