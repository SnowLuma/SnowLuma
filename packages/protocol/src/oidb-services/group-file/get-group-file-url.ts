// 0x6D6_2 — resolve a group file_id → ftn_handler download URL. The
// server returns a `downloadUrl` blob (raw bytes that hex-encode the
// download key) and a `downloadDns` host. This namespace owns retCode
// and the `https://<dns>/ftn_handler/<HEX>/?fname=<fileId>` string.

import { toHexUpper } from '@snowluma/common/hex';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileReq, OidbGroupFileResp, OidbGroupFileDownloadResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

function composeGroupFileUrl(download: OidbGroupFileDownloadResp, fileId: string): string {
  ensureRetCodeZero('group file url', download.retCode, download.retMsg, download.clientWording);
  const dns = (typeof download.downloadDns === 'string' && download.downloadDns)
    || (typeof download.downloadIp === 'string' && download.downloadIp)
    || '';
  const hexUrl = download.downloadUrl instanceof Uint8Array && download.downloadUrl.length > 0
    ? toHexUpper(download.downloadUrl)
    : '';
  if (!dns || !hexUrl) {
    throw new Error('group file url response invalid');
  }
  return `https://${dns}/ftn_handler/${hexUrl}/?fname=${fileId}`;
}

export namespace GetGroupFileUrl {
  export const command = 0x6D6;
  export const subCommand = 2;
  export const uinForm = true;

  export interface Params { groupId: number; fileId: string; busId: number; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupFileReq => ({
    download: {
      groupUin: p.groupId,
      appId: 7,
      busId: p.busId,
      fileId: p.fileId,
    },
  });

  // Default deserialize has no fileId for fname=; invoke() rewires it.
  export const deserialize = (_ctx: Deps, body: OidbGroupFileResp): string => {
    const download = body.download;
    if (!download) throw new Error('group file url response missing');
    return composeGroupFileUrl(download, '');
  };

  export const encode = (env: OidbBase<OidbGroupFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileResp> =>
    protobuf_decode<OidbBase<OidbGroupFileResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<string> =>
    invokeOidb(deps, {
      ...GetGroupFileUrl,
      deserialize: (_ctx, body) => {
        const download = body.download;
        if (!download) throw new Error('group file url response missing');
        return composeGroupFileUrl(download, params.fileId);
      },
    }, params);
}
