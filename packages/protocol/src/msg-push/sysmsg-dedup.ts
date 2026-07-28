import type { MsgPushContext } from './context';

export type SysMsgChatType = 1 | 2;

export interface SysMsgDedupIdentity {
  readonly peerUid: string;
  readonly chatType: SysMsgChatType;
  readonly sequence: number;
  readonly random: number;
}

function getNativeSysMsgChatType(msgType: number, subType: number): SysMsgChatType | null {
  if (msgType === 528 && subType === 290) return 1;
  if (msgType === 166 && (subType === 75 || subType === 129 || subType === 131 || subType === 133 || subType === 135)) return 1;
  if (msgType === 167 && subType === 133) return 1;

  if (msgType === 732 && (subType === 12 || subType === 16 || subType === 20)) return 2;
  if ((msgType === 33 || msgType === 34 || msgType === 85) && subType === 0) return 2;
  return null;
}

/**
 * Derive the identity used by QQ NT's system-message dedup. Only the static
 * `(msgType, subType)` routes proven in `sys_msg_mgr.cc` participate; unknown
 * routes fail open rather than risking suppression of unrelated events.
 */
export function deriveSysMsgDedupIdentity(
  ctx: Pick<MsgPushContext, 'head' | 'fromUin' | 'fromUid'>,
): SysMsgDedupIdentity | null {
  const { head } = ctx;
  const chatType = getNativeSysMsgChatType(head.msgType, head.subType);
  // Decoded zero is also the protobuf default for an absent field. Without a
  // complete server identity, prefer a duplicate event over suppressing two
  // unrelated pushes that collapse to the same default-valued key.
  if (chatType === null || head.sequence === 0 || head.msgId === 0) return null;

  const peerUid = chatType === 1 ? ctx.fromUid : String(ctx.fromUin);
  if (!peerUid || (chatType === 2 && ctx.fromUin === 0)) return null;

  return {
    peerUid,
    chatType,
    sequence: head.sequence,
    random: head.msgId,
  };
}

/**
 * Mirrors QQ NT's system-message dedup so SnowLuma stops double-reporting raw
 * OlPush system events that the QQ kernel would discard before notifying its
 * listeners.
 *
 * macOS QQ 6.9.98 `sys_msg_mgr.cc::ProcessRecvSysMsg` (`sub_E4B94A`) builds:
 *
 *     global_key = `{peerUid}_{chatType}_{msg_seq}_{random}`
 *
 * `sub_E523C8` maps content-head fields 5 and 4 to `msg_seq` and `random`.
 * `sub_E4B30D` supplies chatType from a static `(msgType, subType)` table, and
 * `sub_E4B62A` selects response-head `fromUid` for C2C or decimal `fromUin` for
 * groups. {@link deriveSysMsgDedupIdentity} mirrors those routes exactly.
 */
export class SysMsgDedup {
  private readonly seen = new Set<string>();
  private readonly ring: (string | undefined)[];
  private cursor = 0;

  constructor(private readonly capacity = 1024) {
    this.ring = new Array<string | undefined>(capacity);
  }

  /** Returns true when this native system-message identity was already seen. */
  seenDuplicate(identity: SysMsgDedupIdentity): boolean {
    if (identity.sequence === 0 || identity.random === 0 || !identity.peerUid) return false;
    const key = `${identity.peerUid}_${identity.chatType}_${identity.sequence}_${identity.random}`;
    if (this.seen.has(key)) return true;
    const evicted = this.ring[this.cursor];
    if (evicted !== undefined) this.seen.delete(evicted);
    this.ring[this.cursor] = key;
    this.seen.add(key);
    this.cursor = (this.cursor + 1) % this.capacity;
    return false;
  }
}
