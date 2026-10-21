import { CLIENT_MESSAGE_RECEIPT_CMD, type PacketInfo } from '@snowluma/common/protocol-types';
import type { PacketSender } from '@snowluma/common/packet-sender';
import { isRealUin } from '@snowluma/common/uin';
import { createLogger } from '@snowluma/common/logger';
import type { SendMessageResponse } from '@snowluma/proto-defs/action';
import type { SsoGetC2cMsg, SsoGetC2cMsgResponse } from '@snowluma/proto-defs/get-c2c-msg';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { FriendMessage } from '../events';
import type { IdentityService } from '../identity-service';
import { classifyMessageSurvival } from './blank-filter';
import { buildContextFromMessage } from './context';
import { decodeFriendMessage } from './decoders/friend-message';
import { PkgType } from './enums';
import { SSO_GET_C2C_MSG_CMD } from './fetch-c2c-history';
import { requirePacketResponse } from './packet-response';

const log = createLogger('MsgPush.ClientMessage');
const historyRetryDelays = [100, 250, 500, 1000, 2000] as const;

export interface ClientMessageReceipt {
    readonly peerUid: string;
    readonly clientSequence: number;
    readonly sequence: number;
    readonly timestamp: number;
}

export function decodeClientMessageReceipt(pkt: PacketInfo, selfUin: string): ClientMessageReceipt {
    if (
        pkt.source !== 'client-message' ||
        pkt.serviceCmd !== CLIENT_MESSAGE_RECEIPT_CMD ||
        !isRealUin(selfUin) ||
        pkt.uin !== selfUin
    ) {
        throw new Error('Client message receipt has an invalid source or account');
    }

    if (pkt.retCode !== 0) {
        throw new Error(`Client message receipt is unavailable (status=${pkt.retCode})`);
    }

    const body = Buffer.from(pkt.body);

    if (body.length < 12 || body.length > 8 + 128 + 65536) {
        throw new Error('Client message receipt has an invalid length');
    }

    const peerLength = body[1]!;
    const ackOffset = 8 + peerLength;

    if (
        body[0] !== 1 ||
        body.readUInt16LE(2) !== 0 ||
        peerLength < 3 ||
        peerLength > 128 ||
        ackOffset >= body.length ||
        body.length - ackOffset > 65536
    ) {
        throw new Error('Client message receipt has an invalid envelope');
    }

    const peerUid = body.subarray(8, ackOffset).toString('utf8');
    const clientSequence = body.readUInt32LE(4);

    if (!/^u_[A-Za-z0-9_-]+$/.test(peerUid) || clientSequence === 0) {
        throw new Error('Client message receipt has an invalid message identity');
    }

    const ack = protobuf_decode<SendMessageResponse>(body.subarray(ackOffset));

    if (
        (ack.result ?? 0) !== 0 ||
        (ack.reviewResult ?? 0) !== 0 ||
        (ack.serverResult?.code ?? 0) !== 0
    ) {
        throw new Error('Client message was not accepted');
    }

    const sequence = ack.privateSequence;
    const timestamp = ack.timestamp1;

    if (!sequence || !timestamp || (ack.groupSequence ?? 0) !== 0) {
        throw new Error('Client message receipt has no valid private message confirmation');
    }

    return { peerUid, clientSequence, sequence, timestamp };
}

export async function fetchClientMessage(
    sender: PacketSender,
    identity: IdentityService,
    receipt: ClientMessageReceipt,
): Promise<FriendMessage> {
    const request = protobuf_encode<SsoGetC2cMsg>({
        friendUid: receipt.peerUid,
        startSequence: receipt.sequence,
        endSequence: receipt.sequence,
    });
    let response: SsoGetC2cMsgResponse;

    for (let attempt = 0; ; attempt++) {
        const result = await sender.sendPacket(SSO_GET_C2C_MSG_CMD, Buffer.from(request), 5000);
        response = protobuf_decode<SsoGetC2cMsgResponse>(
            requirePacketResponse(result, 'Client message lookup'),
        );

        if (response.friendUid && response.friendUid !== receipt.peerUid) {
            throw new Error('Client message lookup returned another conversation');
        }

        // A successful send can precede visibility in message storage. Only
        // its explicit not-yet-stored result permits retrying this exact ID.
        if (
            response.result === 100000301 &&
            response.friendUid === receipt.peerUid &&
            !response.messages?.length
        ) {
            const delay = historyRetryDelays[attempt];

            if (delay === undefined) {
                throw new Error(
                    `Client message history is still unavailable after ${attempt + 1} attempts (code=${response.result})`,
                );
            }

            log.debug(
                'Confirmed client message is not yet in history: attempt=%d nextDelayMs=%d',
                attempt + 1,
                delay,
            );
            await new Promise<void>((resolve) => setTimeout(resolve, delay));
            continue;
        }

        if ((response.result ?? 0) !== 0) {
            throw new Error(`Client message lookup failed (code=${response.result})`);
        }

        break;
    }

    if (response.messages?.length !== 1) {
        throw new Error(
            `Client message lookup expected one message, received ${response.messages?.length ?? 0}`,
        );
    }

    const message = response.messages[0]!;
    const head = message.contentHead;
    const route = message.responseHead;
    const selfUin = Number(identity.uin);

    if (
        !head ||
        !route ||
        route.fromUin !== selfUin ||
        route.toUid !== receipt.peerUid ||
        !route.toUin ||
        route.grp != null ||
        head.ntMsgSeq !== receipt.sequence ||
        head.sequence !== receipt.clientSequence ||
        head.timestamp !== receipt.timestamp
    ) {
        throw new Error('Client message lookup did not match the confirmed message');
    }

    if (
        ![
            PkgType.PrivateMessage,
            PkgType.PrivateRecordMessage,
            PkgType.PrivateFileMessage,
            PkgType.ForwardFakePrivateMessage,
        ].includes(head.msgType ?? 0)
    ) {
        throw new Error('Client message lookup returned an unsupported message type');
    }

    const context = buildContextFromMessage(message, selfUin, identity);

    if (!context) {
        throw new Error('Client message lookup has no message context');
    }

    const events = decodeFriendMessage(context);
    const event = events[0];

    if (
        events.length !== 1 ||
        event?.kind !== 'friend_message' ||
        classifyMessageSurvival(context.head, event.elements, context.body) !== 'keep'
    ) {
        throw new Error('Client message lookup has no supported message content');
    }

    return event;
}
