import type { FriendMessage } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

/**
 * A private "qun.invite" ark card (someone DMs the bot a group-invite card)
 * carries the only sequence the server accepts when the bot later approves the
 * invite via 0x10c8 — the `msgseq` embedded in its `mqqapi://group/invite_join`
 * jumpUrl, applied with eventType=2 / filtered=false. The MSF invite push
 * (PkgType 87) never carries it. Parse it out so `set_group_add_request` can
 * use it. See issue #125.
 */
function parseGroupInviteCard(jsonText: string): { groupUin: number; sequence: number } | null {
  if (!jsonText.includes('group/invite_join')) return null;
  const m = jsonText.match(/mqqapi:\/\/group\/invite_join[^"\\\s]*/);
  if (!m) return null;
  const query = m[0].split('?')[1] ?? '';
  const params = new URLSearchParams(query);
  const groupUin = Number(params.get('groupcode') ?? 0);
  const sequence = Number(params.get('msgseq') ?? 0);
  if (!Number.isSafeInteger(groupUin) || !Number.isSafeInteger(sequence)) return null;
  if (groupUin <= 0 || sequence <= 0) return null;
  return { groupUin, sequence };
}

export const decodeFriendMessage: MsgPushDecoder = (ctx) => {
  const elements = decodeRichBody(ctx.body, false);
  // Stash the approval msgseq from a private group-invite card so a later
  // `set_group_add_request` can approve a bot self-invite (issue #125).
  for (const el of elements) {
    if (el.type === 'json' && typeof el.text === 'string') {
      const card = parseGroupInviteCard(el.text);
      if (card) ctx.identity.rememberGroupInviteCardSequence(card.groupUin, card.sequence);
    }
  }
  const ev: FriendMessage = {
    kind: 'friend_message',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    senderUin: ctx.fromUin,
    msgSeq: ctx.head.sequence,
    msgId: ctx.head.msgId & 0x7FFFFFFF,
    elements,
    senderNick: '',
  };
  if (ctx.responseHead?.forward?.friendName) {
    ev.senderNick = ctx.responseHead.forward.friendName;
  }
  const friend = ctx.identity.findFriend(ctx.fromUin);
  if (friend && !ev.senderNick) ev.senderNick = friend.nickname;
  return [ev];
};
