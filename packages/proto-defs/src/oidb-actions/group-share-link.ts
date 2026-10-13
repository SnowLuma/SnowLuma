import type { bool, pb, pb_optional, uint_64 } from '@snowluma/proton';

export interface GroupShareLinkRequest {
    groupCode?: pb<1, uint_64>;
    additionalParam?: pb_optional<3, string>;
    needShortUrl?: pb_optional<4, bool>;
}

export interface OidbGroupShareLinkRequest {
    type?: pb<1, uint_64>;
    group?: pb<12, GroupShareLinkRequest>;
}

export interface GroupShareLinkResponse {
    url?: pb<1, string>;
}

export interface OidbGroupShareLinkResponse {
    group?: pb<12, GroupShareLinkResponse>;
}
