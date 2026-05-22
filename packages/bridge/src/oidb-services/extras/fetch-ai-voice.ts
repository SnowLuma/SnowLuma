// 0x929B_0 — kick off AI voice synthesis and poll until the rendered
// media is available. The server may return an empty msgInfo while
// the render is in-flight; the facade polls up to `maxRetries` times.
//
// `sessionId` is a random 32-bit value used by the server to
// de-duplicate retries of the same synthesis request.
//
// Each `invoke()` is a SINGLE poll — the retry loop lives on the
// facade so callers can plug their own back-off / cancellation in
// without forking the namespace.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbAiVoiceReq, OidbAiVoiceResp,
} from '@snowluma/proto-defs/oidb-actions/media';
import { invokeOidb, type OidbSender } from '../../oidb-service';

/** Subset of AiVoiceMediaIndex (defined in @snowluma/core/apis/shared)
 *  that the AI voice response payload populates. Kept inline here so
 *  the namespace stays self-contained against @snowluma/bridge — the
 *  facade casts back to the richer core-side type. */
export interface AiVoiceMediaIndex {
  info?: { fileSize?: number; fileName?: string; type?: { type?: number; voiceFormat?: number } };
  fileUuid?: string;
  storeId?: number;
  uploadTime?: number;
  ttl?: number;
  subType?: number;
}

export namespace FetchAiVoice {
  export const command = 0x929B;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    voiceId: string;
    text: string;
    chatType: number;
    /** Random 32-bit session id; server uses this to deduplicate polls. */
    sessionId: number;
  }

  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbAiVoiceReq => ({
    groupUin: p.groupId,
    voiceId: p.voiceId,
    text: p.text,
    chatType: p.chatType,
    session: { sessionId: p.sessionId },
  });

  export const deserialize = (body: OidbAiVoiceResp): AiVoiceMediaIndex | null => {
    const node = body.msgInfo?.msgInfoBody?.[0]?.index as AiVoiceMediaIndex | undefined;
    return node ?? null;
  };

  export const encode = (env: OidbBase<OidbAiVoiceReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbAiVoiceReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbAiVoiceResp> =>
    protobuf_decode<OidbBase<OidbAiVoiceResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<AiVoiceMediaIndex | null> =>
    invokeOidb(deps, FetchAiVoice, params);
}
