// 0x6D6_2 — resolve a group file_id → ftn_handler download URL. The
// server returns a `downloadUrl` blob (raw bytes that hex-encode the
// download key) and a `downloadDns` host. The facade composes the
// final `https://<dns>/ftn_handler/<HEX>/?fname=<fileId>` string.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp, OidbGroupFileDownloadResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetGroupFileUrl {
  export const command = 0x6D6;
  export const subCommand = 2;
  export const uinForm = true;

  export interface Params { groupId: number; fileId: string; busId: number; }
  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbGroupFileReq => ({
    download: {
      groupUin: p.groupId,
      appId: 7,
      busId: p.busId,
      fileId: p.fileId,
    },
  });

  export const deserialize = (body: OidbGroupFileResp): OidbGroupFileDownloadResp => {
    const download = body.download;
    if (!download) throw new Error('group file url response missing');
    return download;
  };

  export const encode = (env: OidbBase<OidbGroupFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileResp> =>
    protobuf_decode<OidbBase<OidbGroupFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbGroupFileDownloadResp> =>
    invokeOidb(deps, GetGroupFileUrl, params);
}
