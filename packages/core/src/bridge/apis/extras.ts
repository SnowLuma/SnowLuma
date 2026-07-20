import { FetchAiVoice } from '@snowluma/protocol/oidb-services/extras/fetch-ai-voice';
import {
  FetchAiVoiceList,
  type AiVoiceCategory as NamespaceAiVoiceCategory,
} from '@snowluma/protocol/oidb-services/extras/fetch-ai-voice-list';
import { GetStrangerStatus, type StrangerStatus as NamespaceStrangerStatus } from '@snowluma/protocol/oidb-services/extras/get-stranger-status';
import { GroupTodo } from '@snowluma/protocol/oidb-services/extras/group-todo';
import { convertAudioBytes } from '@snowluma/protocol/highway/ffmpeg-addon';
import { loadBinarySource } from '@snowluma/protocol/highway/utils';
import { createLogger } from '@snowluma/common/logger';
import type { QQEventVariant } from '@snowluma/protocol/events';
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

export interface AiVoiceSendReceipt {
  sequence: number;
}

const log = createLogger('Bridge.Extras');
const AI_VOICE_RECEIPT_TIMEOUT_MS = 5_000;
const AI_VOICE_CANDIDATE_LIMIT = 64;
const AI_VOICE_CLAIM_LIMIT = 256;

type GroupMessageEvent = Extract<QQEventVariant, { kind: 'group_message' }>;

function normalizeMediaUuid(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}

function matchesAiVoiceEvent(node: MediaIndexNode, event: GroupMessageEvent): boolean {
  const expectedUuid = normalizeMediaUuid(node.fileUuid);
  if (!expectedUuid) return false;
  for (const element of event.elements) {
    if (element.type !== 'record') continue;
    const actualUuid = normalizeMediaUuid(element.mediaNode?.fileUuid || element.fileId);
    if (actualUuid === expectedUuid) return true;
  }
  return false;
}

function describeAiVoiceFingerprint(node: MediaIndexNode): string {
  const uuid = normalizeMediaUuid(node.fileUuid);
  if (uuid) return `uuid:${uuid.slice(-12)}`;
  return 'missing';
}

export class ExtrasApi {
  private readonly claimedAiVoiceReceiptKeys = new Set<string>();

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
   * The returned node plugs directly into
   * `apis.groupFile.getPttUrl`, which already handles every other
   * download-URL fetch in SnowLuma. The synthesis response does not contain a
   * reliable message sequence; callers that need one must use `sendAiVoice`,
   * which correlates the subsequent self-message receipt.
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
      if (node) {
        log.debug(
          'AI voice synthesis completed group=%d media=%s polls=%d',
          groupId,
          describeAiVoiceFingerprint(node),
          i + 1,
        );
        return node as MediaIndexNode;
      }
    }
    throw new Error(`AI voice synthesis did not complete after ${maxRetries} polls`);
  }

  /**
   * Publish an AI voice and wait for QQ's canonical self-message receipt.
   *
   * The 0x929B completion response carries the media node but, on live QQ,
   * omits the group message sequence. Subscribe before publishing so an echo
   * that wins the response race is buffered, then correlate by the exact media
   * UUID. Never guess from content hashes or "the next voice in the group":
   * concurrent requests can legitimately render byte-identical audio.
   */
  async sendAiVoice(
    groupId: number,
    voiceId: string,
    text: string,
    chatType: AiVoiceChatType | number,
    receiptTimeoutMs = AI_VOICE_RECEIPT_TIMEOUT_MS,
  ): Promise<AiVoiceSendReceipt> {
    const candidates: GroupMessageEvent[] = [];
    let candidatesOverflowed = false;
    let expectedNode: MediaIndexNode | null = null;
    let receiptSettled = false;
    let resolveReceipt: ((event: GroupMessageEvent) => void) | null = null;
    const receiptPromise = new Promise<GroupMessageEvent>((resolve) => {
      resolveReceipt = resolve;
    });

    const claim = (event: GroupMessageEvent): boolean => {
      if (receiptSettled) return false;
      const key = `${event.groupId}:${event.msgSeq}:${event.msgId}`;
      if (this.claimedAiVoiceReceiptKeys.has(key)) return false;
      this.claimedAiVoiceReceiptKeys.add(key);
      if (this.claimedAiVoiceReceiptKeys.size > AI_VOICE_CLAIM_LIMIT) {
        const oldest = this.claimedAiVoiceReceiptKeys.values().next().value;
        if (oldest !== undefined) this.claimedAiVoiceReceiptKeys.delete(oldest);
      }
      receiptSettled = true;
      return true;
    };

    const accept = (event: GroupMessageEvent): void => {
      if (event.groupId !== groupId || event.senderUin !== event.selfUin) return;
      if (!event.elements.some(element => element.type === 'record')) return;
      if (expectedNode && matchesAiVoiceEvent(expectedNode, event) && claim(event)) {
        resolveReceipt?.(event);
        return;
      }
      candidates.push(event);
      if (candidates.length > AI_VOICE_CANDIDATE_LIMIT) {
        candidates.shift();
        candidatesOverflowed = true;
      }
    };

    const unsubscribe = this.ctx.events.on('group_message', accept);
    let timeout: ReturnType<typeof setTimeout> | null = null;
    try {
      const node = await this.fetchAiVoice(groupId, voiceId, text, chatType);
      expectedNode = node;
      const fingerprint = describeAiVoiceFingerprint(node);
      if (fingerprint === 'missing') {
        throw new Error('AI voice was published but QQ returned no exact media identifier for receipt correlation');
      }

      const buffered = candidates.find(event => matchesAiVoiceEvent(node, event) && claim(event));
      if (!buffered && candidatesOverflowed) {
        throw new Error(
          `AI voice was published but receipt correlation overflowed after ${AI_VOICE_CANDIDATE_LIMIT} `
          + `unmatched self voice messages (group=${groupId} media=${fingerprint})`,
        );
      }
      const event = buffered ?? await Promise.race([
        receiptPromise,
        new Promise<never>((_resolve, reject) => {
          timeout = setTimeout(() => {
            reject(new Error(
              `AI voice was published but no matching group-message receipt arrived within ${receiptTimeoutMs}ms `
              + `(group=${groupId} media=${fingerprint})`,
            ));
          }, receiptTimeoutMs);
          timeout.unref?.();
        }),
      ]);

      if (!Number.isInteger(event.msgSeq) || event.msgSeq <= 0) {
        throw new Error(`AI voice receipt carried invalid message sequence: ${event.msgSeq}`);
      }

      log.debug(
        'AI voice receipt matched group=%d media=%s sequence=%d random=%d',
        groupId,
        fingerprint,
        event.msgSeq,
        event.msgId,
      );
      return {
        sequence: event.msgSeq,
      };
    } finally {
      if (timeout) clearTimeout(timeout);
      unsubscribe();
    }
  }

  // ─────────────── Voice-to-text (pttTrans.Trans{C2C,Group}PttReq) ───────────────

  /**
   * Send ONE `pttTrans.Trans{C2C,Group}PttReq` to trigger transcription and
   * return the recognised text IF the response carries it inline (the
   * already-transcribed case). For a freshly-received voice the response is an
   * empty ack and the text is delivered later via the async Event 0x210
   * subType-61 push — callers should treat `''` as "pending" and wait for the
   * `ptt_trans_result` event (correlated by msgId).
   */
  async translatePttToText(input: PttTransInput): Promise<string> {
    // QQ NT sends the md5 as a 32-char lowercase HEX STRING, not the raw 16
    // bytes (RE'd from wrapper.linux.node EncodeTroopPtt/EncodeC2CPtt: the md5
    // field goes through a bytes→hex helper). Sending raw bytes → errCode -1079.
    const md5 = input.md5Hex.toLowerCase();
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
    if (item?.errCode) {
      // Diagnostic (#165 备选): correlate QQ's errCode with the request fields we
      // sourced from cache, to tell a server-side ASR failure apart from our own
      // missing/zero field (md5/format/uuid). Behaviour unchanged — still throws.
      log.warn(
        'ptt translate errCode=%d isGroup=%s md5=%s format=%d uuid=%s dur=%d size=%d',
        item.errCode, input.isGroup,
        input.md5Hex ? `${input.md5Hex.length / 2}B` : 'EMPTY',
        input.format, input.uuid ? 'set' : 'EMPTY', input.duration, input.size,
      );
      throw new Error(`ptt translate failed: error=${item.errCode}`);
    }
    return item?.text ?? ''; // '' = transcribing async; caller awaits the push
  }

  /**
   * Transcode a voice record (`get_record out_format`, #165). `source` is a
   * URL / local path / `base64://…` (the record's download URL in practice);
   * it is loaded then transcoded to `format` via the bundled SILK-capable
   * ffmpeg addon. Returns base64 + size. Throws on unsupported format or a
   * failed conversion.
   */
  async convertRecord(source: string, format: string): Promise<{ base64: string; size: number }> {
    // Voices are tiny — cap the download well below loadBinarySource's 1 GiB
    // default so a tampered/oversized source can't be pulled in.
    const { bytes } = await loadBinarySource(source, 'record', 64 * 1024 * 1024);
    return convertAudioBytes(bytes, format);
  }
}
