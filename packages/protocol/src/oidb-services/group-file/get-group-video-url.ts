// 0x11EA_200 — video URL fetch, group scope. Same envelope shape as
// GetGroupPttUrl; `requestType=2 + businessType=2` swaps voice for
// video. The scene's `group` block carries the group uin.

import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import {
  normalizeMediaNode, parseNtv2DownloadUrl, type NtMediaIndex,
} from './ntv2-download';

export namespace GetGroupVideoUrl {
  export const command = 0x11EA;
  export const subCommand = 200;
  export const uinForm = true;

  export interface Params { groupId: number; node: NtMediaIndex; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): NTV2RichMediaReq => ({
    reqHead: {
      common: { requestId: 1, command: 200 },
      scene: {
        requestType: 2,
        businessType: 2,
        sceneType: 2,
        group: { groupUin: p.groupId },
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
    invokeOidb(deps, GetGroupVideoUrl, params);
}
