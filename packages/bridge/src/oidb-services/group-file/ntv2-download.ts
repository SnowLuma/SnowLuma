// Shared deserializer for the four NTV2-rich-media URL fetchers:
//   - get-group-ptt-url     (0x126E_200)
//   - get-private-ptt-url   (0x126D_200)
//   - get-group-video-url   (0x11EA_200)
//   - get-private-video-url (0x11E9_200)
//
// All four hit the `MultiMedia.OidbSvc.0x...` family with the same
// `NTV2RichMediaReq` shape; only the `scene` block + the wire cmd
// differ. The response is parsed into a `domain + urlPath +
// rKeyParam` triple → composed into `https://<domain><path><rKey>`.

import type { NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import { ensureRetCodeZero } from '../shared';

export function parseNtv2DownloadUrl(body: NTV2RichMediaResp): string {
  ensureRetCodeZero('ntv2 download', body.respHead?.retCode, body.respHead?.message, undefined);
  const domain = typeof body.download?.info?.domain === 'string' ? body.download.info.domain : '';
  const path = typeof body.download?.info?.urlPath === 'string' ? body.download.info.urlPath : '';
  const rKeyParam = typeof body.download?.rKeyParam === 'string' ? body.download.rKeyParam : '';
  if (!domain || !path) throw new Error('ntv2 download response invalid');
  return `https://${domain}${path}${rKeyParam}`;
}

/** Normalize a MediaIndexNode-shaped object into the wire-fields the
 *  NTV2RichMedia `download.node` slot expects: `info{...}` /
 *  `fileUuid` / `storeId` / `uploadTime` / `ttl` / `subType`. */
export function normalizeMediaNode(node: NtMediaIndex): Record<string, unknown> {
  const fileUuid = typeof node.fileUuid === 'string' ? node.fileUuid : '';
  if (!fileUuid) throw new Error('media node fileUuid is required');

  const info = node.info ?? {};
  const type = info.type ?? {};

  return {
    info: {
      fileSize: toInt(info.fileSize),
      fileHash: typeof info.fileHash === 'string' ? info.fileHash : '',
      fileSha1: typeof info.fileSha1 === 'string' ? info.fileSha1 : '',
      fileName: typeof info.fileName === 'string' ? info.fileName : '',
      type: {
        type: toInt(type.type),
        picFormat: toInt(type.picFormat),
        videoFormat: toInt(type.videoFormat),
        voiceFormat: toInt(type.voiceFormat),
      },
      width: toInt(info.width),
      height: toInt(info.height),
      time: toInt(info.time),
      original: toInt(info.original),
    },
    fileUuid,
    storeId: toInt(node.storeId),
    uploadTime: toInt(node.uploadTime),
    ttl: toInt(node.ttl),
    subType: toInt(node.subType),
  };
}

function toInt(value: unknown): number {
  if (typeof value === 'number' && Number.isFinite(value)) return Math.trunc(value);
  if (typeof value === 'bigint') return Number(value);
  return 0;
}

export interface NtMediaIndex {
  info?: {
    fileSize?: number;
    fileHash?: string;
    fileSha1?: string;
    fileName?: string;
    width?: number;
    height?: number;
    time?: number;
    original?: number;
    type?: {
      type?: number;
      picFormat?: number;
      videoFormat?: number;
      voiceFormat?: number;
    };
  };
  fileUuid?: string;
  storeId?: number;
  uploadTime?: number;
  ttl?: number;
  subType?: number;
}
