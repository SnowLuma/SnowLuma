// 0xE37_800 — c2c (private) offline-file finalize.
//
// Runs AFTER the Highway PUT for a private file. The apply (0xE37_1700)
// + Highway upload get the bytes onto the server, but the recipient
// can't download the file until this call returns the server-issued
// download routing (metadata). Those fields ride along in the outgoing
// PbSendMsg as `FileExtra.field6` — without them the receiver's client
// shows "文件传输失败" even though PbSendMsg returned ok.
//
// NapCat runs this unconditionally (even when the apply reports the file
// already exists). Ported from NapCat `highway/DownloadOfflineFile`.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbOfflineFileFinalizeReq,
  OidbOfflineFileFinalizeResp,
  OidbOfflineFileMetadata,
} from '@snowluma/proto-defs/oidb-actions/media';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace FinalizeOfflineFile {
  export const command = 0xE37;
  export const subCommand = 800;

  export interface Params {
    senderUid: string;
    receiverUid: string;
    fileUuid: string;
    fileHash: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbOfflineFileFinalizeReq => ({
    subCommand: 800,
    field2: 0,
    body: {
      senderUid: p.senderUid,
      receiverUid: p.receiverUid,
      fileUuid: p.fileUuid,
      fileHash: p.fileHash,
    },
    field101: 3,
    field102: 1,
    field200: 1,
  });

  export const deserialize = (_ctx: Deps, body: OidbOfflineFileFinalizeResp): OidbOfflineFileMetadata =>
    body.body?.metadata ?? {};

  export const encode = (env: OidbBase<OidbOfflineFileFinalizeReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbOfflineFileFinalizeReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbOfflineFileFinalizeResp> =>
    protobuf_decode<OidbBase<OidbOfflineFileFinalizeResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbOfflineFileMetadata> =>
    invokeOidb(deps, FinalizeOfflineFile, params);
}
