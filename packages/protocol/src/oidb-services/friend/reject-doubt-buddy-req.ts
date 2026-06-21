// 0xd69_0 — delDoubtBuddyReq: delete/reject (decline) a doubtful friend-add
// request. RE'd from QQNT doubt_buddy_del_worker.cc (worker ctor sub_3F3F320
// → cmd 0xd69 sub 0; EncodeRequest sub_3F3E860 writes {1: const 3, 3:{1:uid}}).
// The top-level tag-1 constant 3 is the op discriminator (getDoubtBuddyReq
// uses 1). Same OIDB cmd as get/approval; the server routes by body shape.
// uin-form OIDB (envelope reserved=1).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbDoubtDelReq } from '@snowluma/proto-defs/oidb-actions/doubt-buddy';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace RejectDoubtBuddyReq {
  export const command = 0xD69;
  export const subCommand = 0;
  export const uinForm = true;

  export interface Params { uid: string }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbDoubtDelReq => ({
    field1: 3,
    inner: { uid: p.uid },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbDoubtDelReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbDoubtDelReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, RejectDoubtBuddyReq, params);
}
