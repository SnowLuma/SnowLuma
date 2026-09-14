// 0x6D9_0 — transfer a temporary group file into permanent group storage.
// Mirrors LagrangeV2's TransFileReqBody shape under the 0x6D9 family.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupSendFileReq,
  OidbGroupSendFileResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero, toInt } from '../shared';

export interface TransGroupFileResult {
  saveBusId: number;
  saveFilePath: string;
}

export namespace TransGroupFile {
  export const command = 0x6D9;
  export const subCommand = 0;

  export interface Params { groupId: number; fileId: string; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupSendFileReq => ({
    transFile: {
      groupUin: BigInt(p.groupId),
      appId: 7,
      busId: 102,
      fileId: p.fileId,
    },
  });

  export const deserialize = (_ctx: Deps, body: OidbGroupSendFileResp): TransGroupFileResult => {
    const result = body.transFile;
    if (!result) throw new Error('group file transfer response missing');
    ensureRetCodeZero('group file transfer', result.retCode, result.retMsg, result.clientWording);
    return {
      saveBusId: toInt(result.saveBusId),
      saveFilePath: typeof result.saveFilePath === 'string' ? result.saveFilePath : '',
    };
  };

  export const encode = (env: OidbBase<OidbGroupSendFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupSendFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupSendFileResp> =>
    protobuf_decode<OidbBase<OidbGroupSendFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<TransGroupFileResult> =>
    invokeOidb(deps, TransGroupFile, params);
}
