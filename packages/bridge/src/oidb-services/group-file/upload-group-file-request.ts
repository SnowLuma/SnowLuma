// 0x6D6_0 — group-file upload preflight. Hands the server the file
// metadata + hashes and gets back:
//   - `boolFileExist` — if true, the bytes are already on the server
//     and the highway step is skipped
//   - `fileId` — the persistent id used by `publish` (0x6D9_4) and
//     later download/delete/move calls
//   - upload host/port + the `fileKey`/`checkKey` blob the highway
//     PUT needs in its FileUploadExt envelope
//
// This namespace ONLY does the preflight; the highway PUT and the
// follow-on `publish` chat-message hop live on the facade because
// they're orchestration (highway client, ext blob composition) that
// doesn't fit a single OIDB call boundary.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp, OidbGroupFileUploadResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace UploadGroupFileRequest {
  export const command = 0x6D6;
  export const subCommand = 0;
  export const uinForm = true;

  export interface Params {
    groupId: number;
    fileName: string;
    folderId: string;
    fileSize: number;
    fileSha1: Uint8Array;
    fileMd5: Uint8Array;
  }

  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbGroupFileReq => ({
    file: {
      groupUin: p.groupId,
      appId: 4,
      busId: 102,
      entrance: 6,
      targetDirectory: p.folderId,
      fileName: p.fileName,
      localDirectory: `/${p.fileName}`,
      fileSize: BigInt(p.fileSize),
      fileSha1: p.fileSha1,
      fileSha3: new Uint8Array(0),
      fileMd5: p.fileMd5,
      field15: true,
    },
  });

  export const deserialize = (body: OidbGroupFileResp): OidbGroupFileUploadResp => {
    const upload = body.upload;
    if (!upload) throw new Error('group file upload response missing');
    return upload;
  };

  export const encode = (env: OidbBase<OidbGroupFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileResp> =>
    protobuf_decode<OidbBase<OidbGroupFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbGroupFileUploadResp> =>
    invokeOidb(deps, UploadGroupFileRequest, params);
}
