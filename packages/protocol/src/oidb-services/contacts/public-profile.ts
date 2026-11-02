import { protobuf_decode, protobuf_getUnknownFields } from '@snowluma/proton';
import { createLogger } from '@snowluma/common/logger';
import type {
    OidbProfilePrivileges,
    OidbProfilePrivilege,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { ProfilePrivilege, PublicProfileFields } from '../../qq-info';

// Shared by the roster and both profile request forms.
export const PUBLIC_PROFILE_KEYS = [
    102, 105, 107, 20003, 20004, 20020, 20009, 20011, 20016, 20021, 20031, 20037, 41756, 41757,
    42241,
];
const log = createLogger('Protocol.Profile');

function text(value: Uint8Array, code: number): string {
    try {
        return new TextDecoder('utf-8', { fatal: true }).decode(value);
    } catch (cause) {
        throw new Error(`invalid UTF-8 in profile property ${code}`, { cause });
    }
}

export function decodeBirthday(
    raw: Uint8Array,
): Pick<PublicProfileFields, 'birthdayYear' | 'birthdayMonth' | 'birthdayDay'> {
    if (raw.length !== 4) {
        throw new Error('invalid birthday length in profile property 20031');
    }

    const year = (raw[0]! << 8) | raw[1]!;
    const month = raw[2]!;
    const day = raw[3]!;

    if (month === 0 && day === 0) {
        return {};
    }

    const date = new Date(0);
    date.setUTCFullYear(year || 2000, month - 1, day);

    if (year > 9999 || date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) {
        throw new Error('invalid date in profile property 20031');
    }

    return {
        ...(year > 0 ? { birthdayYear: year } : {}),
        birthdayMonth: month,
        birthdayDay: day,
    };
}

function privilege(entry: OidbProfilePrivilege): ProfilePrivilege {
    checkKnownFields(entry, [1, 4, 5, 6, 7, 8, 9]);
    return {
        ...(entry.type != null ? { type: entry.type } : {}),
        ...(entry.level != null ? { level: entry.level } : {}),
        ...(entry.flag != null ? { flag: entry.flag } : {}),
        ...(entry.isBig != null ? { isBig: entry.isBig } : {}),
        ...(entry.jumpUrl != null ? { jumpUrl: text(entry.jumpUrl, 107) } : {}),
        ...(entry.iconUrl != null ? { iconUrl: text(entry.iconUrl, 107) } : {}),
        ...(entry.deluxeIconUrl != null ? { deluxeIconUrl: text(entry.deluxeIconUrl, 107) } : {}),
    };
}

function checkKnownFields(value: unknown, tags: readonly number[]): void {
    for (const field of protobuf_getUnknownFields(value)) {
        if (tags.includes(field.fieldNumber)) {
            throw new Error(`unexpected wire type for privilege field ${field.fieldNumber}`);
        }
    }
}

export function decodeMembership(
    numbers: ReadonlyMap<number, number>,
): Pick<PublicProfileFields, 'vipFlag' | 'yearVipFlag' | 'svipFlag' | 'vipLevel'> {
    const result: Pick<PublicProfileFields, 'vipFlag' | 'yearVipFlag' | 'svipFlag' | 'vipLevel'> =
        {};
    const flags = numbers.get(41756);

    if (flags !== undefined) {
        result.vipFlag = (flags & 1) !== 0;
        result.yearVipFlag = (flags & 2) !== 0;
        result.svipFlag = (flags & 0x100) !== 0;
    }

    const level = numbers.get(41757);

    if (level !== undefined) {
        const mask = level & 0xfff;

        if (mask !== 0) {
            result.vipLevel = 33 - Math.clz32(mask);
        } else if (
            result.vipFlag ||
            result.yearVipFlag ||
            result.svipFlag ||
            numbers.get(42241) === 1
        ) {
            result.vipLevel = 1;
        } else if (flags !== undefined && numbers.has(42241)) {
            result.vipLevel = 0;
        }
    }

    return result;
}

export function decodePublicProfile(
    bytes: ReadonlyMap<number, Uint8Array>,
    numbers: ReadonlyMap<number, number>,
): PublicProfileFields {
    const result: PublicProfileFields = {};

    for (const [code, field] of [
        [102, 'sign'],
        [20011, 'email'],
        [20016, 'phoneNum'],
        [20003, 'country'],
        [20004, 'province'],
        [20020, 'city'],
        [20021, 'college'],
    ] as const) {
        const value = bytes.get(code);

        if (value !== undefined) {
            result[field] = text(value, code);
        }
    }

    for (const [code, field] of [
        [20037, 'age'],
        [105, 'level'],
    ] as const) {
        const value = numbers.get(code);

        if (value !== undefined && Number.isInteger(value) && value >= 0) {
            result[field] = value;
        }
    }

    const sex = numbers.get(20009);

    if (sex !== undefined) {
        result.sex = sex === 1 ? 'male' : sex === 2 ? 'female' : 'unknown';
    }

    const birthday = bytes.get(20031);

    if (birthday !== undefined && birthday.length > 0) {
        // Keep the existing optional-birthday behavior, but make malformed
        // upstream values diagnosable without recording personal data.
        try {
            Object.assign(result, decodeBirthday(birthday));
        } catch (error) {
            log.warn(
                'birthday unavailable: bytes=%d error=%s',
                birthday.length,
                error instanceof Error ? error.message : String(error),
            );
        }
    }

    Object.assign(result, decodeMembership(numbers));

    const icons = bytes.get(107);

    if (icons !== undefined) {
        try {
            const decoded = protobuf_decode<OidbProfilePrivileges>(icons);
            checkKnownFields(decoded, [3]);

            if (!decoded.lists) {
                // The client treats an absent list body as unavailable, not
                // as a returned list containing zero entries.
                return result;
            }

            checkKnownFields(decoded.lists, [2, 3, 4]);

            result.privilegeIcons = {
                ...(decoded.lists.jumpUrl != null
                    ? { jumpUrl: text(decoded.lists.jumpUrl, 107) }
                    : {}),
                open: (decoded.lists.open ?? []).map(privilege),
                closed: (decoded.lists.closed ?? []).map(privilege),
            };
        } catch (cause) {
            throw new Error('invalid privilege data in profile property 107', { cause });
        }
    }

    return result;
}
