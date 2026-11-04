import { protobuf_decode } from '@snowluma/proton';
import type { pb, uint_32 } from '@snowluma/proton';

interface OperateTransInfo {
    sourceRaw?: pb<4, uint_32>;
}

/**
 * Join-source metadata in the NapCat `join_ext` shape.
 * `source_raw` packs the platform in the high 16 bits and the source in the low 16.
 */
export type GroupJoinRequestExtension = {
    source_code: number | null;
    platform_code: number | null;
    source_raw: number | null;
};

export type GroupIncreaseExtension = {
    group_id: number;
    user_id: number;
    change_type: number | null;
    operator_uin: number | null;
};

const JOIN_SOURCES: Readonly<Record<number, string>> = {
    0: 'none',
    21: 'qrcode',
    1019: 'search',
    1020: 'search',
    1021: 'search',
    1022: 'search',
    4005: 'search',
    30011: 'search',
    10002: 'none',
    10003: 'findgroup',
    10014: 'findgroup',
    10015: 'findgroup',
    10028: 'findgroup',
    10204: 'findgroup',
    40001: 'link',
};

const GROUP_INCREASE_INVITE = 131;

export function makeGroupJoinRequestExtension(
    operateTransInfo: Uint8Array | undefined,
): GroupJoinRequestExtension {
    let sourceRaw: number | null = null;

    if (operateTransInfo && operateTransInfo.length > 0) {
        try {
            sourceRaw = protobuf_decode<OperateTransInfo>(operateTransInfo).sourceRaw ?? null;
        } catch {
            sourceRaw = null;
        }
    }

    return {
        source_code: sourceRaw === null ? null : sourceRaw & 0xffff,
        platform_code: sourceRaw === null ? null : sourceRaw >>> 16,
        source_raw: sourceRaw,
    };
}

export function sourceForJoinRequest(ext: GroupJoinRequestExtension): string | null {
    return ext.source_code === null ? null : (JOIN_SOURCES[ext.source_code] ?? null);
}

export function sourceForGroupIncrease(changeType: number | null): string | null {
    return changeType === GROUP_INCREASE_INVITE ? 'invite' : null;
}
