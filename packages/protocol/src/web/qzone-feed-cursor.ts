const numericFields = [
    'begintime',
    'dayspac',
    'pagenum',
    'aisortEndTime',
    'aisortOffset',
    'aisortBeginTime',
    'aisortNextTime',
    'icServerTime',
] as const;
const stringFields = ['externparam', 'daylist', 'uinlist'] as const;
const fields = [...numericFields, ...stringFields];
type StateField = (typeof fields)[number];
export type QzoneFeedState = Record<StateField, string>;

export function initialQzoneFeedState(): QzoneFeedState {
    return {
        begintime: '0',
        dayspac: '0',
        pagenum: '1',
        aisortEndTime: '0',
        aisortOffset: '0',
        aisortBeginTime: '0',
        aisortNextTime: '0',
        icServerTime: '0',
        externparam: '',
        daylist: '',
        uinlist: '',
    };
}

function record(value: unknown): value is Record<string, unknown> {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Carry forward the fields used by the web client, including opaque server state. */
export function nextQzoneFeedState(
    main: Record<string, unknown>,
    previous: QzoneFeedState,
): QzoneFeedState {
    const next = { ...previous };

    for (const field of numericFields) {
        const value = main[field];

        if (value === undefined || value === '') {
            continue;
        }

        if (
            (typeof value !== 'number' && typeof value !== 'string') ||
            !/^\d+$/.test(String(value)) ||
            !Number.isSafeInteger(Number(value)) ||
            (field === 'pagenum' && Number(value) < 1)
        ) {
            throw new Error(`空间好友动态分页字段异常: ${field}`);
        }

        next[field] = String(Number(value));
    }

    for (const field of stringFields) {
        const value = main[field];

        if (value === undefined || (value === '' && field !== 'uinlist')) {
            continue;
        }

        if (typeof value !== 'string' || value.length > 32_768) {
            throw new Error(`空间好友动态分页字段异常: ${field}`);
        }

        next[field] = value;
    }

    return next;
}

/** The server clock alone does not constitute pagination progress. */
export function qzoneFeedPosition(state: QzoneFeedState): string {
    return JSON.stringify(
        fields.filter((field) => field !== 'icServerTime').map((field) => state[field]),
    );
}

export function encodeQzoneFeedCursor(uin: string, page: number, state: QzoneFeedState): string {
    if (!Number.isSafeInteger(page) || page < 2) {
        throw new Error('空间好友动态分页页码超出范围');
    }
    const cursor = Buffer.from(JSON.stringify({ version: 1, uin, page, state })).toString(
        'base64url',
    );

    if (cursor.length > 65_536) {
        throw new Error('空间好友动态分页游标过大');
    }

    return cursor;
}

export function decodeQzoneFeedCursor(
    cursor: string,
    uin: string,
): {
    page: number;
    state: QzoneFeedState;
} {
    if (!cursor || cursor.length > 65_536 || !/^[A-Za-z0-9_-]+$/.test(cursor)) {
        throw new Error('无效的空间好友动态 cursor');
    }

    let value: unknown;

    try {
        const bytes = Buffer.from(cursor, 'base64url');

        if (bytes.toString('base64url') !== cursor) {
            throw new Error('non-canonical encoding');
        }

        value = JSON.parse(bytes.toString('utf8'));
    } catch {
        throw new Error('无效的空间好友动态 cursor');
    }

    if (
        !record(value) ||
        value.version !== 1 ||
        value.uin !== uin ||
        typeof value.page !== 'number' ||
        !Number.isSafeInteger(value.page) ||
        value.page < 2 ||
        !record(value.state)
    ) {
        throw new Error('空间好友动态 cursor 无效或不属于当前账号');
    }

    const rawState = value.state;

    if (
        Object.keys(rawState).length !== fields.length ||
        !fields.every((field) => typeof rawState[field] === 'string')
    ) {
        throw new Error('无效的空间好友动态 cursor 状态');
    }

    const state = nextQzoneFeedState(rawState, initialQzoneFeedState());

    if (fields.some((field) => state[field] !== rawState[field])) {
        throw new Error('无效的空间好友动态 cursor 状态');
    }

    return { page: value.page, state };
}
