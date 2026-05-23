// 0x6D7_2 — rename a group folder. Note the wire field is
// `newFolderName` (not `folderName`); the rename slot lives on the
// shared `OidbGroupFileFolderReq` envelope.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileFolderReq, OidbGroupFileFolderResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

export namespace RenameGroupFolder {
  export const command = 0x6D7;
  export const subCommand = 2;
  export const uinForm = true;

  export interface Params { groupId: number; folderId: string; newFolderName: string; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupFileFolderReq => ({
    rename: {
      groupUin: p.groupId,
      folderId: p.folderId,
      newFolderName: p.newFolderName,
    },
  });

  export const deserialize = (_ctx: Deps, body: OidbGroupFileFolderResp): void => {
    const result = body.rename;
    if (!result) throw new Error('group folder rename response missing');
    ensureRetCodeZero('group folder rename', result.retcode, result.retMsg, result.clientWording);
  };

  export const encode = (env: OidbBase<OidbGroupFileFolderReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileFolderReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileFolderResp> =>
    protobuf_decode<OidbBase<OidbGroupFileFolderResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, RenameGroupFolder, params);
}
