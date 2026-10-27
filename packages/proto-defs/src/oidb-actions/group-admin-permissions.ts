import type { pb, pb_optional, pb_repeated, bytes, uint_32, uint_64 } from '@snowluma/proton';

export interface GroupAdminPermissionItem {
    item?: pb<1, uint_32>;
    value?: pb<2, uint_32>;
    extra?: pb<3, bytes>;
}

export interface GroupAdminKickLimit {
    maxKickPerDay?: pb<1, uint_32>;
}

export interface SetGroupAdminPermissionsRequest {
    groupCode?: pb<1, uint_64>;
    memberUin?: pb<2, uint_64>;
    permissions?: pb_repeated<3, GroupAdminPermissionItem>;
}

export interface GroupAdminPermissionsFilter {
    permissions?: pb<52, bytes>;
}

export interface GetGroupAdminPermissionsRequest {
    groupCode?: pb<1, uint_64>;
    memberUins?: pb_repeated<2, uint_64>;
    filter?: pb<4, GroupAdminPermissionsFilter>;
}

export interface GroupAdminPermissions {
    items?: pb_repeated<1, GroupAdminPermissionItem>;
}

export interface GroupAdminPermissionsExt {
    permissions?: pb<52, GroupAdminPermissions>;
}

export interface GroupAdminPermissionsMember {
    memberUin?: pb<1, uint_64>;
    ext?: pb<3, GroupAdminPermissionsExt>;
}

export interface GetGroupAdminPermissionsResponse {
    groupCode?: pb<1, uint_64>;
    members?: pb_repeated<3, GroupAdminPermissionsMember>;
}

export interface GroupAdminReceiveVerifyOperation {
    adminUins?: pb_repeated<1, uint_64>;
    authority?: pb<2, uint_32>;
    operate?: pb_optional<3, uint_32>;
}

export interface SetGroupAdminReceiveVerifyRequest {
    groupCode?: pb<1, uint_64>;
    operation?: pb<2, GroupAdminReceiveVerifyOperation>;
}

export interface GroupAdminReceiveVerifyResult {
    successfulUins?: pb_repeated<1, uint_64>;
}

export interface SetGroupAdminReceiveVerifyResponse {
    groupCode?: pb<1, uint_64>;
    result?: pb<2, GroupAdminReceiveVerifyResult>;
}

export interface GroupAdminReceiveVerifyIdentity {
    uid?: pb<2, string>;
    uin?: pb_optional<4, uint_64>;
}

export interface GroupAdminReceiveVerifyFilter {
    memberFlagExt?: pb<104, uint_32>;
}

export interface GetGroupAdminReceiveVerifyRequest {
    groupCode?: pb<1, uint_64>;
    field2?: pb<2, uint_32>;
    field3?: pb_optional<3, uint_32>;
    filter?: pb<4, GroupAdminReceiveVerifyFilter>;
    members?: pb_repeated<5, GroupAdminReceiveVerifyIdentity>;
}

export interface GroupAdminReceiveVerifyMember {
    identity?: pb<1, GroupAdminReceiveVerifyIdentity>;
    memberFlagExt?: pb_optional<104, uint_32>;
}

export interface GetGroupAdminReceiveVerifyResponse {
    groupCode?: pb<1, uint_64>;
    members?: pb_repeated<2, GroupAdminReceiveVerifyMember>;
}
