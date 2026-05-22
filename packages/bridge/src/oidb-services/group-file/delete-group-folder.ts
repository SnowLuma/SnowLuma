// 0x6D7_1 — delete a group folder by id (any files inside are
// orphaned; UI sometimes pre-empties first via per-file deletes).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileFolderReq, OidbGroupFileFolderResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

export namespace DeleteGroupFolder {
  export const command = 0x6D7;
  export const subCommand = 1;
  export const uinForm = true;

  export interface Params { groupId: number; folderId: string; }
  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbGroupFileFolderReq => ({
    delete: { groupUin: p.groupId, folderId: p.folderId },
  });

  export const deserialize = (body: OidbGroupFileFolderResp): void => {
    const result = body.delete;
    if (!result) throw new Error('group folder delete response missing');
    ensureRetCodeZero('group folder delete', result.retcode, result.retMsg, result.clientWording);
  };

  export const encode = (env: OidbBase<OidbGroupFileFolderReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileFolderReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileFolderResp> =>
    protobuf_decode<OidbBase<OidbGroupFileFolderResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, DeleteGroupFolder, params);
}
