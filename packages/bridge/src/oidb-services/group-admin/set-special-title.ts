// 0x8FC_2 — assign a member a "special title" (群头衔). `expireTime=-1`
// is the wire constant for "permanent".

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbSpecialTitle } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

export namespace SetSpecialTitle {
  export const command = 0x8FC;
  export const subCommand = 2;

  export interface Params { groupId: number; userId: number; title: string; }
  export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;

  export const serialize = (p: Params, targetUid: string): OidbSpecialTitle => ({
    groupUin: p.groupId,
    body: { targetUid, specialTitle: p.title, expireTime: -1 },
  });

  export const deserialize = (_: OidbEmpty): void => {};
  export const encode = (env: OidbBase<OidbSpecialTitle>): Uint8Array =>
    protobuf_encode<OidbBase<OidbSpecialTitle>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    const targetUid = await deps.resolveUserUid(params.userId, params.groupId);
    await invokeOidb(deps, { ...SetSpecialTitle, serialize: p => serialize(p, targetUid) }, params);
  };
}
