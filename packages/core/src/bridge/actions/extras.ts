// Tier-2 napcat-parity actions ported as pure oidb calls. Each function
// here corresponds to one napcat PacketApi.pkt.operation.* entry; the
// schemas live in proto/oidb-action.ts. Nothing in this file touches
// the NTQQ NodeIKernel — every wire trip is one runOidb round-trip.

import type { Bridge } from '../bridge';
import { runOidb } from '../bridge-oidb';
import {
  OidbGroupTodoSchema,
  OidbStrangerStatusReqSchema,
  OidbStrangerStatusRespSchema,
  OidbAiVoiceListReqSchema,
  OidbAiVoiceListRespSchema,
  OidbAiVoiceReqSchema,
  OidbAiVoiceRespSchema,
} from '../proto/oidb-action';
import type { MediaIndexNode } from './shared';

// ─────────────── Group todo (0xF90) ───────────────

export async function setGroupTodo(bridge: Bridge, groupId: number, msgSeq: bigint): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xf90_1',
    oidbCmd: 0xF90, subCmd: 1,
    request: { schema: OidbGroupTodoSchema, value: { groupUin: groupId, msgSeq } },
  });
}

export async function completeGroupTodo(bridge: Bridge, groupId: number, msgSeq: bigint): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xf90_2',
    oidbCmd: 0xF90, subCmd: 2,
    request: { schema: OidbGroupTodoSchema, value: { groupUin: groupId, msgSeq } },
  });
}

export async function cancelGroupTodo(bridge: Bridge, groupId: number, msgSeq: bigint): Promise<void> {
  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xf90_3',
    oidbCmd: 0xF90, subCmd: 3,
    request: { schema: OidbGroupTodoSchema, value: { groupUin: groupId, msgSeq } },
  });
}

// ─────────────── Stranger online/ext status (0xFE1_2) ───────────────

export interface StrangerStatus {
  status: number;
  ext_status: number;
}

/**
 * Mirror napcat's GetStrangerStatus: decode the extBigInt status word.
 * Values ≤10 fold into a 10×status; everything else is split into the
 * high-byte / low-byte ext_status the OneBot dialect uses.
 *
 * Returns null on transport / decode failure rather than throwing, so
 * the OneBot action can produce a clean retcode without try/catch
 * gymnastics.
 */
export async function getStrangerStatus(bridge: Bridge, uin: number): Promise<StrangerStatus | null> {
  try {
    const resp = await runOidb<{ data?: { status?: { value?: bigint | number } } }>(bridge, {
      cmd: 'OidbSvcTrpcTcp.0xfe1_2',
      oidbCmd: 0xFE1, subCmd: 2,
      request: {
        schema: OidbStrangerStatusReqSchema,
        value: { uin, key: [{ key: 27372 }] },
      },
      response: { schema: OidbStrangerStatusRespSchema },
    });
    const raw = resp?.data?.status?.value;
    if (raw === undefined || raw === null) return null;
    const extBig = typeof raw === 'bigint' ? raw : BigInt(raw);
    if (extBig <= 10n) {
      return { status: Number(extBig) * 10, ext_status: 0 };
    }
    const status = Number((extBig & 0xff00n) + ((extBig >> 16n) & 0xffn));
    return { status: 10, ext_status: status };
  } catch {
    return null;
  }
}

// ─────────────── AI voice (0x929D / 0x929B) ───────────────

export const AiVoiceChatType = {
  Unknown: 0,
  Sound: 1,
  Sing: 2,
} as const;
export type AiVoiceChatType = typeof AiVoiceChatType[keyof typeof AiVoiceChatType];

export interface AiVoiceItem {
  voiceId: string;
  voiceDisplayName: string;
  voiceExampleUrl: string;
}

export interface AiVoiceCategory {
  category: string;
  voices: AiVoiceItem[];
}

export async function fetchAiVoiceList(
  bridge: Bridge,
  groupId: number,
  chatType: AiVoiceChatType,
): Promise<AiVoiceCategory[]> {
  const resp = await runOidb<{ content?: AiVoiceCategory[] }>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x929d_0',
    oidbCmd: 0x929D, subCmd: 0,
    request: { schema: OidbAiVoiceListReqSchema, value: { groupUin: groupId, chatType } },
    response: { schema: OidbAiVoiceListRespSchema },
  });
  return resp?.content ?? [];
}

/**
 * Trigger AI voice synthesis. Server may return an empty msgInfo while
 * the render is in-flight; we retry until a node materialises or the
 * cap is hit. napcat uses the same 30-retry budget.
 *
 * The returned MediaIndexNode plugs directly into
 * `bridge.fetchGroupPttUrlByNode`, which already handles every other
 * download-URL fetch in SnowLuma.
 */
export async function fetchAiVoice(
  bridge: Bridge,
  groupId: number,
  voiceId: string,
  text: string,
  chatType: AiVoiceChatType,
  maxRetries = 30,
): Promise<MediaIndexNode> {
  // Random 32-bit session id — server uses this to deduplicate polls.
  const sessionId = Math.floor(Math.random() * 0xFFFFFFFF) >>> 0;
  for (let i = 0; i < maxRetries; i++) {
    const resp = await runOidb<{
      statusCode?: number;
      msgInfo?: { msgInfoBody?: Array<{ index?: MediaIndexNode }> };
    }>(bridge, {
      cmd: 'OidbSvcTrpcTcp.0x929b_0',
      oidbCmd: 0x929B, subCmd: 0,
      request: {
        schema: OidbAiVoiceReqSchema,
        value: { groupUin: groupId, voiceId, text, chatType, session: { sessionId } },
      },
      response: { schema: OidbAiVoiceRespSchema },
    });
    const node = resp?.msgInfo?.msgInfoBody?.[0]?.index;
    if (node) return node;
  }
  throw new Error(`AI voice synthesis did not complete after ${maxRetries} polls`);
}
