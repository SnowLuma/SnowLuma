// 0x126E_200 — fetch a download URL for a group-scope rich-media node
// (voice in this case — busiType=3 means "ptt/voice", sceneType=2
// means group). Pairs with the c2c-scope variant `GetPrivatePttUrl`
// (0x126D_200) which only differs in scene.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { NTV2RichMediaReq, NTV2RichMediaResp } from '@snowluma/proto-defs/oidb-actions/media';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import {
  normalizeMediaNode, parseNtv2DownloadUrl, type NtMediaIndex,
} from './ntv2-download';

export namespace GetGroupPttUrl {
  export const command = 0x126E;
  export const subCommand = 200;
  export const uinForm = true;

  export interface Params { groupId: number; node: NtMediaIndex; }
  export type Deps = OidbSender;

  export const serialize = (p: Params): NTV2RichMediaReq => ({
    reqHead: {
      common: { requestId: 4, command: 200 },
      scene: {
        requestType: 1,
        businessType: 3,
        sceneType: 2,
        group: { groupUin: p.groupId },
      },
      client: { agentType: 2 },
    },
    download: {
      node: normalizeMediaNode(p.node) as any,
      download: { video: { busiType: 0, sceneType: 0 } },
    },
  });

  export const deserialize = parseNtv2DownloadUrl;

  export const encode = (env: OidbBase<NTV2RichMediaReq>): Uint8Array =>
    protobuf_encode<OidbBase<NTV2RichMediaReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<NTV2RichMediaResp> =>
    protobuf_decode<OidbBase<NTV2RichMediaResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<string> =>
    invokeOidb(deps, GetGroupPttUrl, params);
}
