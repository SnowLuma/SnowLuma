// 0xE37_1200 — resolve a private (c2c) file_id → http download URL.
// Carries an opaque 4-byte `field99999` magic the server's deserializer
// requires (Lagrange has the same constant). This namespace owns the
// `http://<server>:<port><url>&isthumb=0` string.
//
// 5s timeout matches the original facade — the server batches these
// at low priority and stalls past the default 30s.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbPrivateFileDownloadReq, OidbPrivateFileDownloadResp,
} from '@snowluma/proto-defs/oidb-actions/media';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { toInt } from '../shared';

const TIMEOUT_MS = 5000;

export namespace GetPrivateFileUrl {
  export const command = 0xE37;
  export const subCommand = 1200;

  export interface Params { selfUid: string; fileId: string; fileHash: string; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbPrivateFileDownloadReq => ({
    subCommand: 1200,
    field2: 1,
    body: {
      receiverUid: p.selfUid,
      fileUuid: p.fileId,
      type: 2,
      fileHash: p.fileHash,
      t2: 0,
    },
    field101: 3,
    field102: 103,
    field200: 1,
    field99999: new Uint8Array([0xC0, 0x85, 0x2C, 0x01]),
  });

  export const deserialize = (_ctx: Deps, body: OidbPrivateFileDownloadResp): string => {
    const result = body.body?.result;
    if (!result) throw new Error('private file url response invalid');
    const server = typeof result.server === 'string' ? result.server : '';
    const port = toInt(result.port);
    const url = typeof result.url === 'string' ? result.url : '';
    if (!server || !port || !url) {
      throw new Error('private file url response invalid');
    }
    return `http://${server}:${port}${url}&isthumb=0`;
  };

  export const encode = (env: OidbBase<OidbPrivateFileDownloadReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbPrivateFileDownloadReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbPrivateFileDownloadResp> =>
    protobuf_decode<OidbBase<OidbPrivateFileDownloadResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<string> =>
    invokeOidb(deps, GetPrivateFileUrl, params, TIMEOUT_MS);
}
