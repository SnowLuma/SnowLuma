// 0xd69_0 — approvalDoubtBuddyReq: approve a doubtful friend-add request
// (可能认识的人). RE'd from QQNT doubt_codec.cc EncodeRequest sub_3F3EC90:
// {1:uid, 2:uid, [3:u32], [4:str]} — tags 3/4 emitted only when present, and
// NapCat passes empty str1/str2, so the approve flow is just {1:uid, 2:uid}.
// Same OIDB cmd as the getter; the server discriminates by body shape.
// uin-form OIDB (envelope reserved=1). The reject/decline path is a separate
// cmd (delDoubtBuddyReq) — see sibling reject-doubt-buddy-req.ts.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbDoubtApprovalReq } from '@snowluma/proto-defs/oidb-actions/doubt-buddy';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace ApproveDoubtBuddyReq {
  export const command = 0xD69;
  export const subCommand = 0;
  export const uinForm = true;

  export interface Params { uid: string }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbDoubtApprovalReq => ({
    uid: p.uid,
    targetUid: p.uid,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbDoubtApprovalReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbDoubtApprovalReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, ApproveDoubtBuddyReq, params);
}
