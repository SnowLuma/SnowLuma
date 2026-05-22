// 0x9067_202 — fetch download-rkey tokens for private/group/fallback
// image scopes. The rkey is a server-issued signed download token used
// to authenticate every CDN GET against `gchat.qpic.cn` / similar
// endpoints.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import { invokeOidb, type OidbSender } from '../../oidb-service';

const PRIVATE_IMAGE = 10;
const GROUP_IMAGE = 20;
const FALLBACK_IMAGE = 2;

export namespace FetchDownloadRkeys {
  export const command = 0x9067;
  export const subCommand = 202;
  export const uinForm = true;

  // eslint-disable-next-line @typescript-eslint/no-empty-object-type
  export interface Params {}

  export type Deps = OidbSender;

  export const serialize = (_: Params): NTV2RichMediaReq => ({
    reqHead: {
      common: { requestId: 1, command: 202 },
      scene: { requestType: 2, businessType: 1, sceneType: 0 },
      client: { agentType: 2 },
    },
    downloadRkey: {
      types: [PRIVATE_IMAGE, GROUP_IMAGE, FALLBACK_IMAGE],
    },
  });

  export const deserialize = (body: NTV2RichMediaResp): NTV2RichMediaResp => {
    // Propagate server-side OIDB-equivalent error via the embedded
    // respHead.retCode — bytes-level OIDB errorCode would already
    // have thrown OidbError before deserialize was called.
    if (body.respHead?.retCode && body.respHead.retCode !== 0) {
      throw new Error(body.respHead.message ?? 'fetch download rkey failed');
    }
    return body;
  };

  export const encode = (env: OidbBase<NTV2RichMediaReq>): Uint8Array =>
    protobuf_encode<OidbBase<NTV2RichMediaReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<NTV2RichMediaResp> =>
    protobuf_decode<OidbBase<NTV2RichMediaResp>>(bytes);

  export const invoke = (deps: Deps): Promise<NTV2RichMediaResp> =>
    invokeOidb(deps, FetchDownloadRkeys, {});
}
