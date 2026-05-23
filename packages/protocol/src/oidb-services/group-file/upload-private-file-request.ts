// 0xE37_1700 — private (c2c) file upload preflight. Server returns
// the same shape of upload-host info as the group-file path but the
// fields are laid out differently (rtpMediaPlatformUploadAddress is
// the primary host source on current QQ-NT; legacy `uploadIp` /
// `uploadDomain` / `uploadIpList[]` are fallbacks).
//
// As with the group-file preflight, this namespace ONLY does the
// preflight; the highway PUT and the follow-on `sendC2cFile` chat
// hop live on the facade.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbPrivateFileUploadReq, OidbPrivateFileUploadResp,
  OidbPrivateFileUploadRespBody,
} from '@snowluma/proto-defs/oidb-actions/media';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace UploadPrivateFileRequest {
  export const command = 0xE37;
  export const subCommand = 1700;

  export interface Params {
    senderUid: string;
    receiverUid: string;
    fileName: string;
    fileSize: number;
    fileSha1: Uint8Array;
    fileMd5: Uint8Array;
    /** md5 over the first 10 MiB; caller passes this in because we
     *  can't redo the hash here without re-reading the source. */
    md510MCheckSum: Uint8Array;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbPrivateFileUploadReq => ({
    command: 1700,
    seq: 0,
    upload: {
      senderUid: p.senderUid,
      receiverUid: p.receiverUid,
      fileSize: p.fileSize,
      fileName: p.fileName,
      md510MCheckSum: p.md510MCheckSum,
      sha1CheckSum: p.fileSha1,
      localPath: '/',
      md5CheckSum: p.fileMd5,
      sha3CheckSum: new Uint8Array(0),
    },
    businessId: 3,
    clientType: 1,
    flagSupportMediaPlatform: 1,
  });

  export const deserialize = (_ctx: Deps, body: OidbPrivateFileUploadResp): OidbPrivateFileUploadRespBody => {
    const upload = body.upload;
    if (!upload) throw new Error('private file upload response missing');
    return upload;
  };

  export const encode = (env: OidbBase<OidbPrivateFileUploadReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbPrivateFileUploadReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbPrivateFileUploadResp> =>
    protobuf_decode<OidbBase<OidbPrivateFileUploadResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbPrivateFileUploadRespBody> =>
    invokeOidb(deps, UploadPrivateFileRequest, params);
}
