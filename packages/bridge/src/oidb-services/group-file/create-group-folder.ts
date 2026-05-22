// 0x6D7_0 — create a sub-folder under `parentId` in the group file
// hierarchy. parentId='/' is the root.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileFolderReq, OidbGroupFileFolderResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

export namespace CreateGroupFolder {
  export const command = 0x6D7;
  export const subCommand = 0;
  export const uinForm = true;

  export interface Params { groupId: number; parentId: string; folderName: string; }
  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbGroupFileFolderReq => ({
    create: {
      groupUin: p.groupId,
      rootDirectory: p.parentId,
      folderName: p.folderName,
    },
  });

  export const deserialize = (body: OidbGroupFileFolderResp): void => {
    const result = body.create;
    if (!result) throw new Error('group folder create response missing');
    ensureRetCodeZero('group folder create', result.retcode, result.retMsg, result.clientWording);
  };

  export const encode = (env: OidbBase<OidbGroupFileFolderReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileFolderReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileFolderResp> =>
    protobuf_decode<OidbBase<OidbGroupFileFolderResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, CreateGroupFolder, params);
}
