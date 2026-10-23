import type { CatalogAction } from './types.js';

export const FILTER_PROPERTIES = {
    category: { type: 'string', description: '按分类过滤，如 群管理 / 消息 / 好友' },
    read_only: { type: 'boolean', description: '只返回指定读写类型的动作' },
    stream: { type: 'boolean', description: '只返回指定流式类型的动作' },
    limit: {
        type: 'integer',
        minimum: 1,
        maximum: 200,
        description: '每页数量；省略时返回全部匹配项',
    },
    offset: { type: 'integer', minimum: 0, description: '跳过的匹配项数量，默认 0' },
};

const SYNONYMS = [
    ['历史消息', '消息历史', 'history'],
    ['群聊', '群', 'group'],
    ['私聊', '好友', 'private', 'friend'],
    ['禁言', 'ban', 'mute'],
    ['撤回', '撤销消息', 'delete_msg', 'recall'],
    ['图片', 'image', 'photo'],
    ['语音', 'record', 'voice'],
    ['文件', 'file'],
    ['上传', 'upload'],
    ['下载', 'download'],
];

export function lite(action: CatalogAction) {
    return {
        name: action.name,
        category: action.category,
        summary: action.summary,
        aliases: action.aliases,
        readOnly: action.readOnly,
        stream: action.stream ?? false,
    };
}

/** Optional controls must not change legacy matching, order or response fields. */
export function discover(actions: CatalogAction[], args: Record<string, unknown>, search: boolean) {
    for (const key of ['read_only', 'stream']) {
        if (args[key] !== undefined && typeof args[key] !== 'boolean') {
            throw new Error(`${key} 必须是布尔值。`);
        }
    }

    for (const key of ['limit', 'offset']) {
        const value = args[key];

        if (
            value !== undefined &&
            (typeof value !== 'number' ||
                !Number.isSafeInteger(value) ||
                value < (key === 'limit' ? 1 : 0) ||
                (key === 'limit' && value > 200))
        ) {
            throw new Error(`${key} 必须是有效整数（limit 为 1–200，offset 不小于 0）。`);
        }
    }

    if (args.match !== undefined && args.match !== 'substring' && args.match !== 'keywords') {
        throw new Error('match 必须为 substring 或 keywords。');
    }

    const query = (typeof args.query === 'string' ? args.query : '').toLowerCase();
    const category = typeof args.category === 'string' ? args.category : undefined;
    const keywords = query.trim().split(/\s+/u).filter(Boolean);
    let list = actions.filter((action) => {
        if (
            (category && action.category !== category) ||
            (args.read_only !== undefined && action.readOnly !== args.read_only) ||
            (args.stream !== undefined && (action.stream ?? false) !== args.stream)
        ) {
            return false;
        }

        if (!search) {
            return true;
        }

        const fields = [action.name, action.summary ?? '', ...action.aliases].map((s) =>
            s.toLowerCase(),
        );

        if (args.match !== 'keywords') {
            return fields.some((field) => field.includes(query));
        }

        return keywords.every((keyword) => {
            const alternatives = SYNONYMS.find((group) => group.includes(keyword)) ?? [keyword];
            return alternatives.some((alternative) =>
                fields.some((field) => field.includes(alternative)),
            );
        });
    });

    if (search && args.match === 'keywords') {
        const exact = (action: CatalogAction) =>
            action.name.toLowerCase() === query.trim() ||
            action.aliases.some((alias) => alias.toLowerCase() === query.trim());
        list = list.sort((a, b) => Number(exact(b)) - Number(exact(a)));
    }

    const offset = typeof args.offset === 'number' ? args.offset : 0;
    const limit = typeof args.limit === 'number' ? args.limit : list.length;
    const page = list.slice(offset, offset + limit).map(lite);
    const paginated = args.limit !== undefined || args.offset !== undefined;
    return {
        count: page.length,
        actions: page,
        ...(paginated
            ? {
                  total: list.length,
                  next_offset: offset + page.length < list.length ? offset + page.length : null,
              }
            : {}),
    };
}
