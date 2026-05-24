// 0x6D6_3 — delete a single group file by id.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

export namespace DeleteGroupFile {
  export const command = 0x6D6;
  export const subCommand = 3;
  export const uinForm = true;

  export interface Params { groupId: number; fileId: string; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupFileReq => ({
    delete: {
      groupUin: p.groupId,
      busId: 102,
      fileId: p.fileId,
    },
  });

  export const deserialize = (_ctx: Deps, body: OidbGroupFileResp): void => {
    const result = body.delete;
    if (!result) throw new Error('group file delete response missing');
    ensureRetCodeZero('group file delete', result.retCode, result.retMsg, result.clientWording);
  };

  export const encode = (env: OidbBase<OidbGroupFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileResp> =>
    protobuf_decode<OidbBase<OidbGroupFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, DeleteGroupFile, params);
}
