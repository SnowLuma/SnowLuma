import type { GroupMessage } from '../../events';
import { decodeGroupDisplayName } from '../../group-member-card';
import type { MsgPushDecoder } from '../registry';
import { decodeRichBody } from '../rich-body-decoder';

export const decodeGroupMessage: MsgPushDecoder = (ctx) => {
    const ev: GroupMessage = {
        kind: 'group_message',
        time: ctx.head.timestamp,
        selfUin: ctx.selfUin,
        senderUin: ctx.fromUin,
        msgSeq: ctx.head.sequence,
        msgId: ctx.head.msgId & 0x7fffffff,
        elements: decodeRichBody(ctx.body, true),
        groupId: 0,
        groupName: '',
        senderNick: '',
        senderCard: '',
        senderRole: '',
    };
    const grp = ctx.responseHead?.grp;
    const displayName = decodeGroupDisplayName(grp);
    const isNickname = grp?.memberCardType === 2;

    ev.groupId = grp?.groupUin ?? 0;
    const member = ctx.identity.findGroupMember(ev.groupId, ctx.fromUin);
    // History supplies an explicit nickname. Live type 2 is also a nickname;
    // a card from an unknown group doubles as a forward node's display name (#201).
    ev.senderNick =
        grp?.memberName ||
        (isNickname ? displayName : undefined) ||
        (member ? member.nickname : displayName) ||
        '';

    if (member) {
        ev.senderCard = member.card ?? '';
        ev.senderRole = member.role;

        // A fresh card supersedes the cache, which can otherwise survive a rename (#1).
        if (!isNickname && displayName !== undefined && displayName !== ev.senderNick) {
            ev.senderCard = displayName;
        }
    }

    // Group name: prefer the message's own wire field (ResponseGrp field 7 —
    // fresh even right after a rename), fall back to the cached group list, else
    // leave it empty. `ev.groupId` is set above from grp.groupUin.
    ev.groupName = grp?.groupName || ctx.identity.findGroup?.(ev.groupId)?.groupName || '';
    return [ev];
};
