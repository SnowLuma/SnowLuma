import { tryDecodeDatalineFriendMessage } from '../../dataline/decode-push';
import type { FriendMessage } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

/** Read the approval tuple from a QQ group-invitation card. */
function parseGroupInviteCard(jsonText: string): { groupUin: number; sequence: number } | null {
    const card: unknown = JSON.parse(jsonText);

    if (
        !card ||
        typeof card !== 'object' ||
        !('app' in card) ||
        (card.app !== 'com.tencent.qun.invite' && card.app !== 'com.tencent.tuwen.lua')
    ) {
        return null;
    }

    if (
        !('meta' in card) ||
        !card.meta ||
        typeof card.meta !== 'object' ||
        !('news' in card.meta) ||
        !card.meta.news ||
        typeof card.meta.news !== 'object' ||
        !('jumpUrl' in card.meta.news) ||
        typeof card.meta.news.jumpUrl !== 'string'
    ) {
        return null;
    }

    const url = URL.parse(card.meta.news.jumpUrl);

    if (
        !url ||
        url.protocol !== 'mqqapi:' ||
        url.hostname !== 'group' ||
        url.pathname !== '/invite_join'
    ) {
        return null;
    }

    const groupUin = Number(url.searchParams.get('groupcode'));
    const sequence = Number(url.searchParams.get('msgseq'));

    if (
        !Number.isSafeInteger(groupUin) ||
        groupUin <= 0 ||
        !Number.isSafeInteger(sequence) ||
        sequence <= 0
    ) {
        throw new Error('group invitation card has an invalid approval tuple');
    }

    return { groupUin, sequence };
}

export const decodeFriendMessage: MsgPushDecoder = (ctx) => {
    const dataline = tryDecodeDatalineFriendMessage(ctx);

    if (dataline) {
        return [dataline];
    }

    const elements = decodeRichBody(ctx.body, false);
    const sentBySelf = ctx.fromUin > 0 && ctx.fromUin === ctx.selfUin;
    const peerUin = sentBySelf ? (ctx.responseHead?.toUin ?? 0) : ctx.fromUin;
    const sequenceAuthoritative = ctx.head.ntMsgSeq > 0;
    let inviteCard: { groupUin: number; sequence: number } | null = null;

    for (const el of elements) {
        if (el.type === 'json' && typeof el.text === 'string') {
            inviteCard = parseGroupInviteCard(el.text);

            if (inviteCard) {
                break;
            }
        }
    }

    const ev: FriendMessage = {
        kind: 'friend_message',
        time: ctx.head.timestamp,
        selfUin: ctx.selfUin,
        senderUin: ctx.fromUin,
        senderUid: ctx.fromUid,
        ...(peerUin > 0 ? { peerUin } : {}),
        msgSeq: ctx.head.sequence,
        ntMsgSeq: ctx.head.ntMsgSeq,
        clientSeq: ctx.head.sequence,
        sequenceAuthoritative,
        msgId: ctx.head.msgId & 0x7fffffff,
        elements,
        senderNick: '',
        ...(inviteCard
            ? {
                  inviteCardGroupUin: inviteCard.groupUin,
                  inviteCardSequence: inviteCard.sequence,
              }
            : {}),
    };

    if (ctx.responseHead?.forward?.friendName) {
        ev.senderNick = ctx.responseHead.forward.friendName;
    }

    const friend = ctx.identity.findFriend(ctx.fromUin);

    if (friend && !ev.senderNick) {
        ev.senderNick = friend.nickname;
    }

    return [ev];
};
