// 0xFE1_2 — fetch a user's profile (nickname / qid / sex / age / birthday /
// phone / email / sign / avatar / QQ level).
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
//   107   — business icons (proto-encoded OidbProfileBusiness)
//   20002 — nickname
//   20009 — gender (1 male / 2 female / 255 unknown)
//   20037 — age
//   20031 — birthday (uint16 big-endian year, uint8 month, uint8 day)
//   20011 — email
//   20016 — masked phone number
//   20003 — self-reported country (UTF-8 bytes)
//   20004 — self-reported province (UTF-8 bytes)
//   20020 — self-reported city (UTF-8 bytes)
//   20021 — school / college (UTF-8 bytes)
//   27394 — QID

import { protobuf_decode, protobuf_encode, protobuf_getUnknownFields } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    AvatarInfo,
    OidbCustomStatus,
    OidbProfileBusiness,
    OidbUserInfoRequest,
    OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { ProfileBusinessInfo, UserProfileInfo } from '../../qq-info';
import { unpackStatusWord } from '../extras/get-stranger-status';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { parseBirthday } from './profile-fields';

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

/** Decode property 107 independently so one damaged property cannot discard a profile. */
function applyProfileBusiness(info: UserProfileInfo, bytesMap: Map<number, Uint8Array>): void {
    const bytes = bytesMap.get(107);

    if (!bytes) {
        return;
    }

    const rejectWrongWireType = (value: unknown, knownFields: readonly number[]): void => {
        if (
            protobuf_getUnknownFields(value).some((field) =>
                knownFields.includes(field.fieldNumber),
            )
        ) {
            throw new Error('business property contains an invalid wire type');
        }
    };

    try {
        const business = protobuf_decode<OidbProfileBusiness>(bytes);
        rejectWrongWireType(business, [3]);

        if (business.body == null) {
            return;
        }

        rejectWrongWireType(business.body, [1, 3]);
        const entries: ProfileBusinessInfo[] = [];

        for (const entry of business.body.lists ?? []) {
            rejectWrongWireType(entry, [1, 2, 3, 4, 5, 6, 7]);

            if (entry.icon1 != null && entry.icon2 != null) {
                // Proton does not retain oneof wire order. Do not guess which icon won.
                throw new Error('business property contains conflicting icons');
            }

            const iconBytes = entry.icon1 ?? entry.icon2;
            const icon =
                iconBytes == null
                    ? undefined
                    : new TextDecoder('utf-8', { fatal: true }).decode(iconBytes);
            entries.push({
                type: entry.type,
                level: entry.level,
                isYear: entry.isYear,
                isPro: entry.isPro,
                ...(icon ? { icon } : {}),
            });
        }

        info.profileBusiness = entries;
    } catch {
        // Missing and rejected business data must not masquerade as an empty list.
    }
}

/** Apply the public profile fields shared by the UIN and UID request forms. */
export function applyPublicProfileFields(
    info: UserProfileInfo,
    bytesMap: Map<number, Uint8Array>,
    numMap: Map<number, number>,
): void {
    const getString = (code: number): string => {
        const bytes = bytesMap.get(code);
        return bytes ? Buffer.from(bytes).toString('utf8') : '';
    };

    const birthday = parseBirthday(bytesMap.get(20031));

    if (birthday) {
        info.birthdayYear = birthday.year;
        info.birthdayMonth = birthday.month;
        info.birthdayDay = birthday.day;
    }

    const phoneNum = getString(20016).trim();

    if (phoneNum) {
        info.phoneNum = phoneNum;
    }

    const email = getString(20011).trim();

    if (email) {
        info.email = email;
    }

    // Mania's FE1 parser confirms city=20020 and school=20021; the legacy
    // 0x5EB property schema distinguishes province=20004 from city=20020.
    // Missing or malformed text must stay unavailable rather than inventing a value.
    for (const [code, field] of [
        [20003, 'country'],
        [20004, 'province'],
        [20020, 'city'],
        [20021, 'college'],
    ] as const) {
        const bytes = bytesMap.get(code);

        if (!bytes) {
            continue;
        }

        try {
            const value = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trim();

            if (value) {
                info[field] = value;
            }
        } catch {
            // A rejected individual property must not discard the rest of the profile.
        }
    }

    const sexNum = numMap.get(20009) ?? 0;
    info.sex = sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown';
    info.age = numMap.get(20037) ?? 0;
    info.level = numMap.get(105) ?? 0;

    applyProfileBusiness(info, bytesMap);

    info.availableFields = [];

    if (bytesMap.has(102)) {
        info.availableFields.push('sign');
    }

    for (const [key, field] of [
        [20009, 'sex'],
        [20037, 'age'],
        [105, 'level'],
    ] as const) {
        if (numMap.has(key)) {
            info.availableFields.push(field);
        }
    }
}

const REQUESTED_KEYS = [
    20002, 27394, 20009, 20031, 20011, 20016, 101, 103, 102, 107, 20020, 20021, 20003, 20004, 20026,
    105, 27372, 27406, 20037, 41756, 41757, 42241,
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

            applyPublicProfileFields(info, bytesMap, numMap);
            applyOnlineStatus(info, bytesMap, numMap);
            applyProfileDetails(info, numMap);
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
