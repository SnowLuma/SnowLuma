// Tier-2 napcat-parity actions ported as pure oidb calls. Each function
// here corresponds to one napcat PacketApi.pkt.operation.* entry; the
// schemas live in proto/oidb-action.ts. Nothing in this file touches
// the NTQQ NodeIKernel — every wire trip is one runOidb round-trip.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { Bridge } from '../bridge';
import { runOidb, makeOidbEnvelope } from '../bridge-oidb';
import { OidbBase } from '../proto/proton/oidb';
import type {
  OidbAiVoiceListReq,
  OidbAiVoiceListResp,
  OidbAiVoiceReq,
  OidbAiVoiceResp,
  OidbGroupTodo,
  OidbStrangerStatusReq,
  OidbStrangerStatusResp,
} from '../proto/proton/oidb-action';
import type { MediaIndexNode } from './shared';

// ─────────────── Group todo (0xF90) ───────────────

export async function setGroupTodo(bridge: Bridge, groupId: number, msgSeq: bigint): Promise<void> {
  const env = makeOidbEnvelope<OidbGroupTodo>(0xF90, 1, { groupUin: groupId, msgSeq });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0xf90_1', protobuf_encode<OidbBase<OidbGroupTodo>>(env));
}

export async function completeGroupTodo(bridge: Bridge, groupId: number, msgSeq: bigint): Promise<void> {
  const env = makeOidbEnvelope<OidbGroupTodo>(0xF90, 2, { groupUin: groupId, msgSeq });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0xf90_2', protobuf_encode<OidbBase<OidbGroupTodo>>(env));
}

export async function cancelGroupTodo(bridge: Bridge, groupId: number, msgSeq: bigint): Promise<void> {
  const env = makeOidbEnvelope<OidbGroupTodo>(0xF90, 3, { groupUin: groupId, msgSeq });
  await runOidb(bridge, 'OidbSvcTrpcTcp.0xf90_3', protobuf_encode<OidbBase<OidbGroupTodo>>(env));
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
    const env = makeOidbEnvelope<OidbStrangerStatusReq>(
      0xFE1, 2,
      { uin, key: [{ key: 27372 }] } as any,
      // Same UIN-form flag fetchUserProfile sets — without it newer
      // QQ NT rejects with `[oidb] one of uid/openid is invaild`.
      true,
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xfe1_2', protobuf_encode<OidbBase<OidbStrangerStatusReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbStrangerStatusResp>>(respBytes).body;
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
  const env = makeOidbEnvelope<OidbAiVoiceListReq>(0x929D, 0, { groupUin: groupId, chatType });
  const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x929d_0', protobuf_encode<OidbBase<OidbAiVoiceListReq>>(env));
  const resp = protobuf_decode<OidbBase<OidbAiVoiceListResp>>(respBytes).body;
  return (resp?.content as AiVoiceCategory[] | undefined) ?? [];
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
    const env = makeOidbEnvelope<OidbAiVoiceReq>(
      0x929B, 0,
      { groupUin: groupId, voiceId, text, chatType, session: { sessionId } },
    );
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x929b_0', protobuf_encode<OidbBase<OidbAiVoiceReq>>(env));
    const resp = protobuf_decode<OidbBase<OidbAiVoiceResp>>(respBytes).body;
    const node = resp?.msgInfo?.msgInfoBody?.[0]?.index as MediaIndexNode | undefined;
    if (node) return node;
  }
  throw new Error(`AI voice synthesis did not complete after ${maxRetries} polls`);
}
