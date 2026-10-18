export interface UpdateSourceConfig {
    mode: 'auto' | 'direct' | 'mirror';
    mirror: string;
    mirrors: string[];
}

export function normalizeMirrorUrl(value: unknown): string {
    if (typeof value !== 'string' || value.length > 2048) {
        throw new Error('镜像地址必须是 HTTP(S) URL');
    }

    let url: URL;

    try {
        url = new URL(value.trim());
    } catch {
        throw new Error('镜像地址必须是 HTTP(S) URL');
    }

    if (
        !['http:', 'https:'].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.search ||
        url.hash
    ) {
        throw new Error('镜像地址仅支持 HTTP(S)，不能包含账号、密码、查询参数或片段');
    }

    return url.href.replace(/\/+$/, '');
}

export function normalizeUpdateSourceConfig(value: unknown): UpdateSourceConfig {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
        throw new Error('更新来源必须是对象');
    }

    if (
        !('mode' in value) ||
        (value.mode !== 'auto' && value.mode !== 'direct' && value.mode !== 'mirror')
    ) {
        throw new Error('更新来源模式无效');
    }

    if (!('mirrors' in value) || !Array.isArray(value.mirrors) || value.mirrors.length > 16) {
        throw new Error('自动筛选最多支持 16 个镜像');
    }

    const mirror = 'mirror' in value && value.mirror !== '' ? normalizeMirrorUrl(value.mirror) : '';

    if (value.mode === 'mirror' && !mirror) {
        throw new Error('请指定镜像地址');
    }

    return {
        mode: value.mode,
        mirror,
        mirrors: [...new Set(value.mirrors.map(normalizeMirrorUrl))],
    };
}
