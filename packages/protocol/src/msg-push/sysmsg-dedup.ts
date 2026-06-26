import type { MsgPushHead } from './context';

/**
 * Mirrors QQ NT's system-message dedup so SnowLuma stops double-reporting the
 * duplicate sys pushes the server emits for some events (#137: inviting an
 * official robot pushes the `group_member_increase` notice twice → two
 * `notice.group_increase`; a normal member is pushed once).
 *
 * RE of `wrapper.linux.node` — `sys_msg_mgr.cc::ProcessRecvSysMsg`
 * (`sub_37BADE0`): every received system message is keyed and looked up in a
 * per-account set; an already-seen key is logged ("on recv sys msg, ignore dup
 * msg … global_key={}", sys_msg_mgr.cc:467) and the whole message is dropped
 * before the UI / JS listeners ever see it. The key (`sub_37BC4E0`) is
 *
 *     global_key = `{peerUid}_{chatType}_{msg_seq}_{random}`
 *
 * whose per-message discriminators are `msg_seq` (attr 40003 = contentHead
 * field 5) and `random` (attr 40002 = contentHead field 4) — exactly
 * {@link MsgPushHead.sequence} and {@link MsgPushHead.msgId} here
 * (`msg_header_codec_helper.cc` sub_37C8AD0). Kernel-based bots (NapCat /
 * LLOneBot) receive events *after* this dedup; SnowLuma reads the raw OlPush
 * *before* it, so we replicate it here.
 *
 * We dedup at the push level (drop the whole duplicate, like NT) using the
 * fields already on the head plus `fromUin` for peer scoping (a stand-in for
 * peerUid — `msg_seq` can be per-conversation, so the peer keeps two groups'
 * pushes from colliding; `random`/`msgId` makes the collision astronomically
 * unlikely anyway). A push with no server identity (`sequence` or `msgId` 0) is
 * never deduped — without a real per-message id we cannot distinguish a true
 * duplicate from two distinct events, and dropping then would be a regression.
 */
export class SysMsgDedup {
  private readonly seen = new Set<string>();
  // Fixed-capacity ring of keys for O(1) bounded eviction (oldest-out). System
  // pushes are low-frequency, so a duplicate always lands within a few entries
  // of its original — eviction only matters far beyond the dup window.
  private readonly ring: (string | undefined)[];
  private cursor = 0;

  constructor(private readonly capacity = 1024) {
    this.ring = new Array<string | undefined>(capacity);
  }

  /**
   * Returns true if a system push with this identity was already seen (caller
   * should drop it); otherwise records it and returns false.
   */
  seenDuplicate(head: Pick<MsgPushHead, 'msgType' | 'subType' | 'sequence' | 'msgId'>, fromUin: number): boolean {
    if (head.sequence === 0 || head.msgId === 0) return false;
    const key = `${head.msgType}:${head.subType}:${fromUin}:${head.sequence}:${head.msgId}`;
    if (this.seen.has(key)) return true;
    const evicted = this.ring[this.cursor];
    if (evicted !== undefined) this.seen.delete(evicted);
    this.ring[this.cursor] = key;
    this.seen.add(key);
    this.cursor = (this.cursor + 1) % this.capacity;
    return false;
  }
}
