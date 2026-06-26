// 0x12b6_0 — getBuddyRecommendContactArkJson: ask the server to build a
// "recommend contact" ARK share card for a friend (by uin). Returns the
// ark JSON string the card is rendered from. The request body writes
// uin/phone/jump_url; response body field 1 is the ark string.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbBuddyRecommendArkReq, OidbBuddyRecommendArkResp,
} from '@snowluma/proto-defs/oidb-actions/contact-ark';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetBuddyRecommendArk {
  export const command = 0x12B6;
  export const subCommand = 0;
  export const uinForm = false;

  export interface Params { userId: number; phoneNumber?: string }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbBuddyRecommendArkReq => ({
    uin: p.userId,
    phoneNumber: p.phoneNumber || '-',
    // Client-side jump_url the kernel hard-codes alongside the uin; the
    // server echoes it into the card. Mirrors the NT template exactly.
    jumpUrl: `mqqapi://card/show_pslcard?src_type=internal&source=sharecard&version=1&uin=${p.userId}`,
  });

  export const deserialize = (_ctx: Deps, body: OidbBuddyRecommendArkResp): string => body.ark ?? '';

  export const encode = (env: OidbBase<OidbBuddyRecommendArkReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbBuddyRecommendArkReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbBuddyRecommendArkResp> =>
    protobuf_decode<OidbBase<OidbBuddyRecommendArkResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<string> =>
    invokeOidb(deps, GetBuddyRecommendArk, params);
}
