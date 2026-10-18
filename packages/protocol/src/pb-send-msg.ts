// pb-send-msg — self-sent message echo for the injected QQ client.
//
// #528: with `reportSelfMessage` enabled, a message the operator types inside
// the injected QQ client never reaches OneBot as `message_sent`. QQ does not
// push that message back to its own client — it already has it locally — so the
// `MessageSvc.PbSendMsg` transaction is the only trace, and its response used
// to fall through the packet pipeline as `parser_unregistered`.
//
// Registering a parser for the command turns that dead end into an event: the
// outbound request (`fromClient = true`) carries the routing head and rich
// text, the response carries the server sequence. Pair them by `seqId` and
// synthesise the same `group_message` / `friend_message` shape an inbound push
// produces, with `senderUin` set to the logged-in account — the OneBot
// converter already maps that to `post_type: "message_sent"`.
//
// Messages SnowLuma itself sends are deliberately excluded: every random
// `Bridge.nextMessageRandom()` mints is registered here, and those sends
// already emit a self-sent event from the OneBot layer. Re-emitting them would
// double-report the same message.
//
// Out of scope: `routingHead.grpTmp` (temp sessions) and `trans0x211` (c2c
// files) are not chat messages, so their transactions are ignored rather than
// guessed at.

import { createLogger } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { SendMessageRequest, SendMessageResponse } from '@snowluma/proto-defs/action';
import type { MessageBody } from '@snowluma/proto-defs/message';
import { protobuf_decode } from '@snowluma/proton';
import { decodeRichBody } from './msg-push/rich-body-decoder';
import type { IdentityService } from './identity-service';
import type { QQEventVariant } from './events';

export const PB_SEND_MSG_CMD = 'MessageSvc.PbSendMsg';

const log = createLogger('PbSendMsg');

/** A reply whose request was never observed must not accumulate. */
const MAX_PENDING = 256;
/** One entry per send; sends are far rarer than receives, but stay bounded. */
const MAX_SELF_RANDOMS = 256;
/** QQ's own client re-uses a send random well inside a minute. */
const ENTRY_TTL_MS = 120_000;

interface StashedRequest {
    isGroup: boolean;
    /** groupId for groups, peer UIN for private chats. */
    targetId: number;
    body: MessageBody;
    random: number;
    clientSeq: number;
    stashedAt: number;
}

type GroupMessageEvent = Extract<QQEventVariant, { kind: 'group_message' }>;
type FriendMessageEvent = Extract<QQEventVariant, { kind: 'friend_message' }>;

/**
 * Request/response pairing plus the set of randoms SnowLuma itself minted.
 * Owned by the `Bridge` instance (one per QQ account) so state never leaks
 * across accounts, mirroring how `SysMsgDedup` is threaded through MsgPush.
 */
export class PbSendMsgEchoTracker {
    private readonly pending = new Map<number, StashedRequest>();
    private readonly selfRandoms = new Map<number, number>();

    /** Called from `Bridge.nextMessageRandom()` for every minted random. */
    rememberSelfRandom(random: number): void {
        if (!Number.isSafeInteger(random) || random <= 0) {
            return;
        }

        this.selfRandoms.set(random, Date.now());
        trimOldest(this.selfRandoms, MAX_SELF_RANDOMS);
    }

    isSelfRandom(random: number): boolean {
        return random > 0 && this.selfRandoms.has(random);
    }

    stash(seqId: number, request: StashedRequest): void {
        this.pending.set(seqId, request);
        trimOldest(this.pending, MAX_PENDING);
    }

    /** Returns and removes the request, so a reply is never used twice. */
    take(seqId: number): StashedRequest | undefined {
        const request = this.pending.get(seqId);

        if (request) {
            this.pending.delete(seqId);
        }

        return request;
    }

    prune(now: number): void {
        for (const [seqId, request] of this.pending) {
            if (now - request.stashedAt > ENTRY_TTL_MS) {
                this.pending.delete(seqId);
            }
        }

        for (const [random, at] of this.selfRandoms) {
            if (now - at > ENTRY_TTL_MS) {
                this.selfRandoms.delete(random);
            }
        }
    }
}

/**
 * `MessageSvc.PbSendMsg` → self-sent message event.
 *
 * The request packet is only remembered; the event is produced from the
 * response, because that is the first moment the server has confirmed a
 * sequence for the message.
 */
export function parsePbSendMsg(
    pkt: PacketInfo,
    identity: IdentityService,
    tracker: PbSendMsgEchoTracker,
): QQEventVariant[] {
    tracker.prune(Date.now());

    if (pkt.fromClient) {
        stashOutboundRequest(pkt, tracker);
        return [];
    }

    return emitSelfSentEcho(pkt, identity, tracker);
}

function stashOutboundRequest(pkt: PacketInfo, tracker: PbSendMsgEchoTracker): void {
    const request = protobuf_decode<SendMessageRequest>(pkt.body);

    if (!request) {
        return;
    }

    const routing = request.routingHead;
    const groupCode = routing?.grp?.groupCode;
    const isGroup = groupCode != null && Number(groupCode) > 0;
    const targetId = isGroup ? Number(groupCode) : Number(routing?.c2c?.uin ?? 0);

    // Temp sessions (grpTmp) and c2c file routes (trans0x211) are not chat
    // messages; ignoring them keeps a stray transaction from inventing one.
    if (targetId <= 0) {
        return;
    }

    const richText = request.messageBody?.richText;

    if (!richText?.elems || richText.elems.length === 0) {
        return;
    }

    tracker.stash(pkt.seqId, {
        isGroup,
        targetId,
        body: { richText },
        random: Number(request.random ?? 0),
        clientSeq: Number(request.clientSequence ?? 0),
        stashedAt: Date.now(),
    });
}

function emitSelfSentEcho(
    pkt: PacketInfo,
    identity: IdentityService,
    tracker: PbSendMsgEchoTracker,
): QQEventVariant[] {
    const stashed = tracker.take(pkt.seqId);

    if (!stashed) {
        // A response without an observed request is not a chat-message send
        // (file finalize, heartbeat, or a reply that arrived after a restart).
        return [];
    }

    if (tracker.isSelfRandom(stashed.random)) {
        // SnowLuma sent this itself; the OneBot layer already reported it.
        log.trace(() => [
            'self-send ignored (already reported by the action path): target=%d group=%s',
            stashed.targetId,
            stashed.isGroup,
        ]);
        return [];
    }

    const response = protobuf_decode<SendMessageResponse>(pkt.body);

    if (!response) {
        return [];
    }

    if (response.result != null && response.result !== 0) {
        log.debug(
            'manual send rejected by the server (result=%s) — no event emitted',
            response.result,
        );
        return [];
    }

    const elements = decodeRichBody(stashed.body, stashed.isGroup);

    if (elements.length === 0) {
        return [];
    }

    const selfUin = Number(pkt.uin) || Number(identity.uin) || 0;
    const time = positiveInt(response.timestamp1) ?? Math.floor(Date.now() / 1000);
    const groupSequence = positiveInt(response.groupSequence) ?? 0;
    const privateSequence = positiveInt(response.privateSequence) ?? 0;

    if (stashed.isGroup) {
        const event: GroupMessageEvent = {
            kind: 'group_message',
            time,
            selfUin,
            groupId: stashed.targetId,
            // A send response carries neither the group name nor card data;
            // the identity cache is the only source and is not wired here.
            groupName: '',
            senderUin: selfUin,
            senderNick: identity.nickname,
            senderCard: '',
            senderRole: '',
            msgSeq: groupSequence,
            msgId: groupSequence,
            elements,
        };

        return [event];
    }

    const event: FriendMessageEvent = {
        kind: 'friend_message',
        time,
        selfUin,
        senderUin: selfUin,
        peerUin: stashed.targetId,
        senderNick: identity.nickname,
        msgSeq: privateSequence > 0 ? privateSequence : stashed.clientSeq,
        // `ntMsgSeq` is the conversation-wide C2C sequence; only the server
        // response knows it, so a missing one keeps the client sequence and
        // flags it non-authoritative (same rule as inbound pushes).
        ntMsgSeq: privateSequence > 0 ? privateSequence : undefined,
        clientSeq: stashed.clientSeq,
        sequenceAuthoritative: privateSequence > 0,
        msgId: privateSequence,
        elements,
    };

    return [event];
}

function positiveInt(value: number | bigint | undefined): number | undefined {
    if (value == null) {
        return undefined;
    }

    const parsed = Number(value);

    return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : undefined;
}

function trimOldest<T>(map: Map<number, T>, max: number): void {
    while (map.size > max) {
        const oldest = map.keys().next();

        if (oldest.done) {
            break;
        }

        map.delete(oldest.value);
    }
}
