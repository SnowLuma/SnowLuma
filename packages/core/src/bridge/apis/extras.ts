import { FetchAiVoice } from '@snowluma/protocol/oidb-services/extras/fetch-ai-voice';
import {
  FetchAiVoiceList,
  type AiVoiceCategory as NamespaceAiVoiceCategory,
} from '@snowluma/protocol/oidb-services/extras/fetch-ai-voice-list';
import { GetStrangerStatus, type StrangerStatus as NamespaceStrangerStatus } from '@snowluma/protocol/oidb-services/extras/get-stranger-status';
import { GroupTodo } from '@snowluma/protocol/oidb-services/extras/group-todo';
import type { PttTransReq, PttTransResp } from '@snowluma/proto-defs/ptt-trans';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '../bridge-context';
import type { MediaIndexNode } from './shared';

/** Inputs for a voice-to-text request, gathered from the received `record`
 *  element + its message meta. `uuid`/`md5Hex` come from the cached record;
 *  the uins + scene from the message meta. */
export interface PttTransInput {
  isGroup: boolean;
  msgId: number;
  senderUin: number;
  /** Receiver uin (c2c) or group uin (group). */
  peerUin: number;
  uuid: string;
  md5Hex: string;
  duration: number;
  size: number;
  format: number;
  /** Group ptt numeric file id (group only; optional). */
  fileId?: number;
}

function hexToBytes(hex: string): Uint8Array {
  const s = (hex || '').trim();
  if (!s) return new Uint8Array(0);
  const len = s.length >> 1;
  const out = new Uint8Array(len);
  for (let i = 0; i < len; i++) out[i] = parseInt(s.substr(i * 2, 2), 16);
  return out;
}

// ─────────────── public types (re-exported from bridge.ts as before) ───

export type StrangerStatus = NamespaceStrangerStatus;

export const AiVoiceChatType = {
  Unknown: 0,
  Sound: 1,
  Sing: 2,
} as const;
export type AiVoiceChatType = typeof AiVoiceChatType[keyof typeof AiVoiceChatType];

export type AiVoiceCategory = NamespaceAiVoiceCategory;
export interface AiVoiceItem {
  voiceId: string;
  voiceDisplayName: string;
  voiceExampleUrl: string;
}

export class ExtrasApi {
  constructor(private readonly ctx: BridgeContext) { }

  // ─────────────── Group todo (0xF90) ───────────────

  setGroupTodo(groupId: number, msgSeq: bigint): Promise<void> {
    return GroupTodo.invoke(this.ctx, { groupId, msgSeq, action: 'set' });
  }

  completeGroupTodo(groupId: number, msgSeq: bigint): Promise<void> {
    return GroupTodo.invoke(this.ctx, { groupId, msgSeq, action: 'complete' });
  }

  cancelGroupTodo(groupId: number, msgSeq: bigint): Promise<void> {
    return GroupTodo.invoke(this.ctx, { groupId, msgSeq, action: 'cancel' });
  }

  // ─────────────── Stranger online/ext status (0xFE1_2) ───────────────

  /**
   * Returns `null` on transport / decode failure rather than throwing,
   * so the OneBot action can produce a clean retcode without try/catch
   * gymnastics. Namespace throws on transport failure → swallow here.
   */
  async getStrangerStatus(uin: number): Promise<StrangerStatus | null> {
    try {
      return await GetStrangerStatus.invoke(this.ctx, { uin });
    } catch {
      return null;
    }
  }

  // ─────────────── AI voice (0x929D / 0x929B) ───────────────

  fetchAiVoiceList(groupId: number, chatType: AiVoiceChatType | number): Promise<AiVoiceCategory[]> {
    return FetchAiVoiceList.invoke(this.ctx, { groupId, chatType });
  }

  /**
   * Trigger AI voice synthesis. Server may return an empty msgInfo while
   * the render is in-flight; we retry until a node materialises or the
   * cap is hit. napcat uses the same 30-retry budget.
   *
   * The returned MediaIndexNode plugs directly into
   * `apis.groupFile.getPttUrl`, which already handles every other
   * download-URL fetch in SnowLuma.
   */
  async fetchAiVoice(
    groupId: number,
    voiceId: string,
    text: string,
    chatType: AiVoiceChatType | number,
    maxRetries = 30,
  ): Promise<MediaIndexNode> {
    // Random 32-bit session id — server uses this to deduplicate polls.
    const sessionId = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
    for (let i = 0; i < maxRetries; i++) {
      const node = await FetchAiVoice.invoke(this.ctx, { groupId, voiceId, text, chatType, sessionId });
      if (node) return node as MediaIndexNode;
    }
    throw new Error(`AI voice synthesis did not complete after ${maxRetries} polls`);
  }

  // ─────────────── Voice-to-text (pttTrans.Trans{C2C,Group}PttReq) ───────────────

  /**
   * Send ONE `pttTrans.Trans{C2C,Group}PttReq` to trigger transcription and
   * return the recognised text IF the response carries it inline (the
   * already-transcribed case). For a freshly-received voice the response is an
   * empty ack and the text is delivered later via the async Event 0x210
   * subType-61 push — callers should treat `''` as "pending" and wait for the
   * `ptt_trans_result` event (correlated by msgId). Live-verified end to end.
   */
  async translatePttToText(input: PttTransInput): Promise<string> {
    const md5 = hexToBytes(input.md5Hex);
    const req: PttTransReq = input.isGroup
      ? {
        type: 1,
        groupItem: {
          msgId: BigInt(input.msgId), senderUin: BigInt(input.senderUin), groupUin: BigInt(input.peerUin),
          fileId: input.fileId ?? 0, md5, duration: input.duration, size: input.size,
          format: input.format, uuid: input.uuid,
        },
      }
      : {
        type: 2,
        c2cItem: {
          msgId: BigInt(input.msgId), senderUin: BigInt(input.senderUin), receiverUin: BigInt(input.peerUin),
          uuid: input.uuid, duration: input.duration, size: input.size, format: input.format, md5,
        },
      };
    const cmd = input.isGroup ? 'pttTrans.TransGroupPttReq' : 'pttTrans.TransC2CPttReq';

    const result = await this.ctx.sendRawPacket(cmd, protobuf_encode<PttTransReq>(req));
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(result.errorMessage || 'ptt translate request failed');
    }
    const resp = protobuf_decode<PttTransResp>(result.responseData);
    const item = input.isGroup ? resp?.groupResult : resp?.c2cResult;
    if (item?.errCode) throw new Error(`ptt translate failed: error=${item.errCode}`);
    return item?.text ?? ''; // '' = transcribing async; caller awaits the push
  }
}
