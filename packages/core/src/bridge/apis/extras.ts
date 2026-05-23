// ExtrasApi — facade over Tier-2 napcat-parity OIDB cmds (group
// todo CRUD / stranger status decode / AI voice list + synthesis).
// Every method is a one-line forwarder to a self-contained namespace
// under @snowluma/protocol/oidb-services/extras.

import type { MediaIndexNode } from './shared';
import type { BridgeContext } from '../bridge-context';
import { GroupTodo } from '@snowluma/protocol/oidb-services/extras/group-todo';
import { GetStrangerStatus, type StrangerStatus as NamespaceStrangerStatus } from '@snowluma/protocol/oidb-services/extras/get-stranger-status';
import {
  FetchAiVoiceList,
  type AiVoiceCategory as NamespaceAiVoiceCategory,
} from '@snowluma/protocol/oidb-services/extras/fetch-ai-voice-list';
import { FetchAiVoice } from '@snowluma/protocol/oidb-services/extras/fetch-ai-voice';

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
  constructor(private readonly ctx: BridgeContext) {}

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
}
