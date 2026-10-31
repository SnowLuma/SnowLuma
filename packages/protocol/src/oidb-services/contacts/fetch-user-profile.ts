// 0xFE1_2 — fetch a user's profile (nickname / qid / sex / age / sign
// / avatar / QQ level).
//
// `uinForm` is set so the server takes the UIN-form validation path;
// without it newer NTQQ versions reject the request with
// `[oidb] one of uid/openid is invaild`. Matches Lagrange.Core's
// FetchStrangerByUin (Reserved = 1).
//
// Property key catalogue (cross-checked against LagrangeV2's
// FetchStrangerService.cs):
//   101   — avatar info (proto-encoded AvatarInfo)
//   102   — sign (signature)
//   103   — remark
//   105   — QQ level (numeric)
//   20002 — nickname
//   20009 — gender (1 male / 2 female / 255 unknown)
//   20031 — birthday (4 bytes: uint16 BE year, month, day)
//   20037 — age
//   27394 — QID

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    AvatarInfo,
    OidbCustomStatus,
    OidbUserInfoRequest,
    OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { UserProfileInfo } from '../../qq-info';
import { unpackStatusWord } from '../extras/get-stranger-status';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export function applyOnlineStatus(
    info: UserProfileInfo,
    bytesMap: Map<number, Uint8Array>,
    numMap: Map<number, number>,
): void {
    const statusRaw = numMap.get(27372);

    if (statusRaw !== undefined) {
        const unpacked = unpackStatusWord(statusRaw);
        info.status = unpacked.status;
        info.extStatus = unpacked.ext_status;
        info.batteryStatus = 0;
    }

    const customBytes = bytesMap.get(27406);

    if (customBytes && customBytes.length > 0) {
        const custom = protobuf_decode<OidbCustomStatus>(customBytes);
        info.customStatus = {
            faceId: custom.faceId ?? 0,
            wording: custom.msg ?? '',
        };
        info.customStatusDesc = custom.msg ?? '';
    }
}

export function applyProfileDetails(info: UserProfileInfo, numMap: Map<number, number>): void {
    const registered = numMap.get(20026);

    if (registered !== undefined && registered > 0) {
        info.regTime = registered;
    }

    const flags = numMap.get(41756);

    if (flags !== undefined) {
        info.vipFlag = (flags & 1) !== 0;
        info.yearVipFlag = (flags & 2) !== 0;
        info.svipFlag = (flags & 0x100) !== 0;
    }

    const level = numMap.get(41757);

    if (level !== undefined) {
        const mask = level & 0xfff;

        if (mask !== 0) {
            info.vipLevel = 33 - Math.clz32(mask);
        } else if (info.vipFlag || info.yearVipFlag || info.svipFlag || numMap.get(42241) === 1) {
            info.vipLevel = 1;
        } else if (flags !== undefined && numMap.has(42241)) {
            info.vipLevel = 0;
        }
    }
}

/**
 * 生日（bytes-property 20031）：年 uint16 大端 + 月 + 日，与 Lagrange.Core
 * `FetchStrangerService.cs` 的解析一致。月或日为 0 表示未设置生日；
 * 年份为 0 表示未公开出生年份，此时只省略年份。
 */
export function applyBirthday(info: UserProfileInfo, bytesMap: Map<number, Uint8Array>): void {
    const raw = bytesMap.get(20031);

    if (raw?.length !== 4) {
        return;
    }

    const bytes = Buffer.from(raw);
    const year = bytes.readUInt16BE(0);
    const month = bytes.readUInt8(2);
    const day = bytes.readUInt8(3);

    // A hidden year can still represent February 29.
    const date = new Date(0);
    date.setUTCFullYear(year || 2000, month - 1, day);

    if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        return;
    }

    if (year > 0) {
        info.birthdayYear = year;
    }

    info.birthdayMonth = month;
    info.birthdayDay = day;
}

const REQUESTED_KEYS = [
    20002, 27394, 20009, 20031, 101, 103, 102, 20020, 20003, 20026, 105, 27372, 27406, 20037, 41756,
    41757, 42241,
    // 企点标志（QQ 企点 / 企业版 QQ 账号）：员工号实测为 1，普通账号为 0
    40410, 42031,
];

export namespace FetchUserProfile {
    export const command = 0xfe1;
    export const subCommand = 2;
    export const uinForm = true;

    export interface Params {
        uin: number;
    }

    export type Deps = OidbSender;

    export const serialize = (_ctx: Deps, p: Params): OidbUserInfoRequest => ({
        uin: p.uin,
        keys: REQUESTED_KEYS.map((k) => ({ key: k })),
    });

    /** Defaults the response uin to `requestedUin` because the server
     *  sometimes elides its echo. `invoke` below binds `params.uin` via
     *  the spec override so the namespace's call surface still takes
     *  only `(ctx, body)`. */
    export const deserializeWithFallback = (
        body: OidbUserInfoResponse,
        requestedUin: number,
    ): UserProfileInfo => {
        if (!body.body) {
            throw new Error('user info response body missing');
        }

        const info: UserProfileInfo = {
            uin: body.body.uin ?? requestedUin,
            uid: body.body.uid ?? '',
            nickname: '',
            remark: '',
            qid: '',
            sex: 'unknown',
            age: 0,
            sign: '',
            avatar: '',
            level: 0,
            qidianMasterFlag: 0,
            qidianCrewFlag: 0,
            qidianCrewFlag2: 0,
        };

        if (body.body.properties) {
            const bytesMap = new Map<number, Uint8Array>();
            const numMap = new Map<number, number>();

            for (const bp of body.body.properties.bytesProperties ?? []) {
                bytesMap.set(bp.code ?? 0, bp.value ?? new Uint8Array(0));
            }

            for (const np of body.body.properties.numberProperties ?? []) {
                numMap.set(np.number1 ?? 0, np.number2 ?? 0);
            }

            const getString = (code: number): string => {
                const b = bytesMap.get(code);
                return b ? Buffer.from(b).toString('utf8') : '';
            };

            info.nickname = getString(20002);
            info.remark = getString(103);
            info.qid = getString(27394);
            info.sign = getString(102);

            const avatarBytes = bytesMap.get(101);

            if (avatarBytes) {
                const av = protobuf_decode<AvatarInfo>(avatarBytes);

                if (av?.url) {
                    info.avatar = av.url + '640';
                }
            }

            const sexNum = numMap.get(20009) ?? 0;
            info.sex = sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown';
            info.age = numMap.get(20037) ?? 0;
            info.level = numMap.get(105) ?? 0;
            applyOnlineStatus(info, bytesMap, numMap);
            applyProfileDetails(info, numMap);
            applyBirthday(info, bytesMap);
            // 企点标志：40410 / 42031，服务器仅在返回时才出现（普通账号缺省 → 0）
            info.qidianMasterFlag = numMap.get(42031) ?? 0;
            info.qidianCrewFlag = numMap.get(40410) ?? 0;
        }

        return info;
    };

    // Default deserialize uses uin=0 fallback — invoke() rewires it to
    // the requested uin via the per-call spec override below. Tests
    // that call deserialize directly should use deserializeWithFallback.
    export const deserialize = (_ctx: Deps, body: OidbUserInfoResponse): UserProfileInfo =>
        deserializeWithFallback(body, 0);

    export const encode = (env: OidbBase<OidbUserInfoRequest>): Uint8Array =>
        protobuf_encode<OidbBase<OidbUserInfoRequest>>(env);

    export const decode = (bytes: Uint8Array): OidbBase<OidbUserInfoResponse> =>
        protobuf_decode<OidbBase<OidbUserInfoResponse>>(bytes);

    export const invoke = (deps: Deps, params: Params): Promise<UserProfileInfo> =>
        invokeOidb(
            deps,
            {
                ...FetchUserProfile,
                deserialize: (_ctx, body) => deserializeWithFallback(body, params.uin),
            },
            params,
        );
}
