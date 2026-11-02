import type { FriendInfo, ProfilePrivilege, PublicProfileFields } from '@snowluma/protocol/qq-info';
import type { JsonObject } from '../types';

function formatPrivilege(value: ProfilePrivilege): JsonObject {
    return {
        ...(value.type !== undefined ? { type: value.type } : {}),
        ...(value.level !== undefined ? { level: value.level } : {}),
        ...(value.flag !== undefined ? { flag: value.flag } : {}),
        ...(value.isBig !== undefined ? { is_big: value.isBig } : {}),
        ...(value.jumpUrl !== undefined ? { jump_url: value.jumpUrl } : {}),
        ...(value.iconUrl !== undefined ? { icon_url: value.iconUrl } : {}),
        ...(value.deluxeIconUrl !== undefined ? { deluxe_icon_url: value.deluxeIconUrl } : {}),
    };
}

export function formatPublicProfile(profile: PublicProfileFields = {}): JsonObject {
    const result: JsonObject = {};

    for (const [source, target] of [
        ['sign', 'long_nick'],
        ['sex', 'sex'],
        ['age', 'age'],
        ['level', 'level'],
        ['birthdayYear', 'birthday_year'],
        ['birthdayMonth', 'birthday_month'],
        ['birthdayDay', 'birthday_day'],
        ['phoneNum', 'phone_num'],
        ['email', 'email'],
        ['country', 'country'],
        ['province', 'province'],
        ['city', 'city'],
        ['college', 'college'],
        ['vipFlag', 'is_qq_vip'],
        ['svipFlag', 'is_vip'],
        ['yearVipFlag', 'is_years_vip'],
        ['vipLevel', 'vip_level'],
    ] as const) {
        if (profile[source] !== undefined) {
            result[target] = profile[source];
        }
    }

    if (profile.privilegeIcons !== undefined) {
        result.privilege_icons = {
            ...(profile.privilegeIcons.jumpUrl !== undefined
                ? { jump_url: profile.privilegeIcons.jumpUrl }
                : {}),
            open: profile.privilegeIcons.open.map(formatPrivilege),
            closed: profile.privilegeIcons.closed.map(formatPrivilege),
        };
    }

    return result;
}

export function formatFriend(friend: FriendInfo, categoryId = friend.categoryId): JsonObject {
    return {
        user_id: friend.uin,
        nickname: friend.nickname,
        remark: friend.remark,
        ...(categoryId !== undefined ? { category_id: categoryId } : {}),
        ...formatPublicProfile(friend.profile),
    };
}
