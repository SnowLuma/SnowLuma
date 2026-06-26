// 0x6D6_4 — rename a group file (not a folder; that is 0x6D7_2). The
// rename slot lives on the shared `OidbGroupFileReq` envelope at field 5.
// Wire fields verified against NapCat's Oidb.0x6D6 transformer
// (busId=102, parentFolder = the file's CURRENT parent directory).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

export namespace RenameGroupFile {
  export const command = 0x6D6;
  export const subCommand = 4;
  export const uinForm = true;

  export interface Params {
    groupId: number; fileId: string;
    parentDirectory: string; newFileName: string;
  }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupFileReq => ({
    rename: {
      groupUin: p.groupId,
      busId: 102,
      fileId: p.fileId,
      parentFolder: p.parentDirectory,
      newFileName: p.newFileName,
    },
  });

  export const deserialize = (_ctx: Deps, body: OidbGroupFileResp): void => {
    const result = body.rename;
    if (!result) throw new Error('group file rename response missing');
    ensureRetCodeZero('group file rename', result.retCode, result.retMsg, result.clientWording);
  };

  export const encode = (env: OidbBase<OidbGroupFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileResp> =>
    protobuf_decode<OidbBase<OidbGroupFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, RenameGroupFile, params);
}
