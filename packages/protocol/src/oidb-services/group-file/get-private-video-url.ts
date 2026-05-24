// 0x11E9_200 — c2c-scope video URL fetch (pair of GetGroupVideoUrl).
// `scene.c2c.targetUid` is the bot's own uid; the server uses it as
// the read-side identity for the asset lookup.

import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import {
  normalizeMediaNode, parseNtv2DownloadUrl, type NtMediaIndex,
} from './ntv2-download';

export namespace GetPrivateVideoUrl {
  export const command = 0x11E9;
  export const subCommand = 200;
  export const uinForm = true;

  export interface Params { selfUid: string; node: NtMediaIndex; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): NTV2RichMediaReq => ({
    reqHead: {
      common: { requestId: 1, command: 200 },
      scene: {
        requestType: 2,
        businessType: 2,
        sceneType: 1,
        c2c: { accountType: 2, targetUid: p.selfUid },
      },
      client: { agentType: 2 },
    },
    download: {
      node: normalizeMediaNode(p.node),
      download: { video: { busiType: 0, sceneType: 0 } },
    },
  });

  export const deserialize = (_ctx: Deps, body: NTV2RichMediaResp): string => parseNtv2DownloadUrl(body);

  export const encode = (env: OidbBase<NTV2RichMediaReq>): Uint8Array =>
    protobuf_encode<OidbBase<NTV2RichMediaReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<NTV2RichMediaResp> =>
    protobuf_decode<OidbBase<NTV2RichMediaResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<string> =>
    invokeOidb(deps, GetPrivateVideoUrl, params);
}
