import type { int_64, pb, pb_optional } from '@snowluma/proton';

/** Personal-space emotion identity carried in GetFeedDetail's base64 ugc_id. */
export interface QzoneEmotionUgcId {
    appId: pb<1, int_64>;
    uin: pb<2, int_64>;
    publishTime: pb<3, int_64>;
    // These empty fields have explicit presence in the upstream identifier.
    field4: pb_optional<4, string>;
    field5: pb_optional<5, string>;
    field6: pb<6, string>;
    tid: pb<8, string>;
}
