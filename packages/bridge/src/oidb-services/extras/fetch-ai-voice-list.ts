// 0x929D_0 — fetch the catalog of AI voices available for synthesis
// in a given group, grouped by category. Returns the categories
// straight from the wire (caller already expects the wire shape).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbAiVoiceListReq, OidbAiVoiceListResp,
} from '@snowluma/proto-defs/oidb-actions/media';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface AiVoiceItem {
  voiceId: string;
  voiceDisplayName: string;
  voiceExampleUrl: string;
}

export interface AiVoiceCategory {
  category: string;
  voices: AiVoiceItem[];
}

export namespace FetchAiVoiceList {
  export const command = 0x929D;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    chatType: number;
  }

  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbAiVoiceListReq => ({
    groupUin: p.groupId,
    chatType: p.chatType,
  });

  export const deserialize = (body: OidbAiVoiceListResp): AiVoiceCategory[] =>
    (body.content as AiVoiceCategory[] | undefined) ?? [];

  export const encode = (env: OidbBase<OidbAiVoiceListReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbAiVoiceListReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbAiVoiceListResp> =>
    protobuf_decode<OidbBase<OidbAiVoiceListResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<AiVoiceCategory[]> =>
    invokeOidb(deps, FetchAiVoiceList, params);
}
