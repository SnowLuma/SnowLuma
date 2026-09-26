// Approve an existing filtered friend request.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbDoubtApprovalReq } from '@snowluma/proto-defs/oidb-actions/doubt-buddy';
import type { BridgeContext } from '../../bridge-context';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { resolveSelfUid } from '../../self-uid';

export namespace ApproveDoubtBuddyReq {
  export const command = 0xD72;
  export const subCommand = 0;
  export const uinForm = false;

  export interface Params { uid: string }
  export type Deps = OidbSender & Pick<BridgeContext, 'identity' | 'resolveUserUid'>;

  export const serialize = async (ctx: Deps, p: Params): Promise<OidbDoubtApprovalReq> => {
    if (!p.uid.trim()) throw new Error('cannot approve doubt request: applicant uid is unavailable');
    const selfUid = await resolveSelfUid(ctx);
    if (!selfUid.trim()) throw new Error('cannot approve doubt request: self uid is unavailable');
    return {
      selfUid,
      targetUid: p.uid,
      field3: 0,
      field4: '',
    };
  };

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbDoubtApprovalReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbDoubtApprovalReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, ApproveDoubtBuddyReq, params);
}
