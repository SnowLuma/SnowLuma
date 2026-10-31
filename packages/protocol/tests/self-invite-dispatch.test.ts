import type { PacketInfo } from '@snowluma/common/protocol-types';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import type { GroupInviteEvent, QQEventVariant } from '@snowluma/protocol/events';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { GroupInviteTracker } from '@snowluma/protocol/group-invite-tracker';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { afterEach, describe, expect, it, vi } from 'vitest';

const SELF_UIN = 10001;
const GROUP_ID = 12345;
const INVITOR_UID = 'u_inviter';
const INVITOR_UIN = 20002;

afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
});

function packet(): PacketInfo {
    return {
        pid: 42,
        uin: String(SELF_UIN),
        serviceCmd: 'test.self-invite',
        seqId: 1,
        retCode: 0,
        fromClient: false,
        body: Buffer.from([0x00]),
    };
}

/** The MSF notice: no approval msgseq, only the legacy flag from the decoder. */
function selfInviteNotice(): GroupInviteEvent {
    return {
        kind: 'group_invite',
        time: 1,
        selfUin: SELF_UIN,
        groupId: GROUP_ID,
        fromUin: INVITOR_UIN,
        fromUid: INVITOR_UID,
        invitedUin: SELF_UIN,
        invitedUid: undefined,
        subType: 'invite',
        message: '',
        flag: `invite:${GROUP_ID}:${INVITOR_UID}`,
    };
}

/** The private "qun.invite" card, which carries the real approval msgseq. */
function inviteCard(sequence = 777): QQEventVariant {
    return {
        kind: 'friend_message',
        time: 1,
        selfUin: SELF_UIN,
        senderUin: INVITOR_UIN,
        senderUid: INVITOR_UID,
        senderNick: 'inviter',
        msgSeq: 1,
        msgId: 2,
        elements: [],
        inviteCardGroupUin: GROUP_ID,
        inviteCardSequence: sequence,
    } as QQEventVariant;
}

function makePipeline(options: { request?: 'found' | 'missing' } = {}) {
    const identity = IdentityService.memory(String(SELF_UIN));
    const events = new BridgeEventBus();
    const received: QQEventVariant[] = [];
    events.onAny((event) => {
        // The card arrives as a friend_message and the pipeline derives a
        // group_invite from it; only the latter is under test here.
        if ((event as QQEventVariant).kind === 'group_invite') {
            received.push(event as QQEventVariant);
        }
    });

    const resolveGroupJoinRequest = vi.fn(async () =>
        options.request === 'found'
            ? {
                  groupId: GROUP_ID,
                  groupName: '',
                  targetUid: 'u_target',
                  targetUin: 0,
                  targetName: '',
                  invitorUid: INVITOR_UID,
                  invitorUin: INVITOR_UIN,
                  invitorName: '',
                  operatorUid: '',
                  operatorUin: 0,
                  operatorName: '',
                  sequence: 42,
                  state: 1,
                  notifyType: 1,
                  eventType: 1,
                  comment: '',
                  filtered: false,
              }
            : null,
    );

    const pipeline = new IncomingPacketPipeline({
        identity,
        events,
        fetchGroupList: vi.fn(async () => {}),
        fetchGroupMemberList: vi.fn(async () => {}),
        resolveGroupJoinRequest,
        groupInvites: new GroupInviteTracker(),
    });

    return { pipeline, received, resolveGroupJoinRequest };
}

describe('self-invite delivery', () => {
    it('dispatches a self-invite that the request inbox cannot resolve', async () => {
        const { pipeline, received } = makePipeline({ request: 'missing' });
        pipeline.registerCmd('test.self-invite', () => [selfInviteNotice()]);

        await pipeline.process(packet());

        expect(received).toHaveLength(1);
        expect(received[0]).toMatchObject({
            kind: 'group_invite',
            groupId: GROUP_ID,
            invitedUin: SELF_UIN,
            subType: 'invite',
        });
    });

    it('keeps the decoder-provided legacy flag so the request stays actionable', async () => {
        const { pipeline, received } = makePipeline({ request: 'missing' });
        pipeline.registerCmd('test.self-invite', () => [selfInviteNotice()]);

        await pipeline.process(packet());

        expect((received[0] as GroupInviteEvent).flag).toBe(
            `invite:${GROUP_ID}:${INVITOR_UID}`,
        );
    });

    it('keeps the legacy flag even when the inbox has a matching request', async () => {
        // Self-invite notices are absent from the UIN-based inbox, so the pipeline
        // does not consult it at all -- the legacy flag must therefore survive.
        const { pipeline, received, resolveGroupJoinRequest } = makePipeline({ request: 'found' });
        pipeline.registerCmd('test.self-invite', () => [selfInviteNotice()]);

        await pipeline.process(packet());

        expect(resolveGroupJoinRequest).not.toHaveBeenCalled();
        expect((received[0] as GroupInviteEvent).flag).toBe(
            `invite:${GROUP_ID}:${INVITOR_UID}`,
        );
    });

    it('does not query the inbox and still dispatches a self-invite', async () => {
        const { pipeline, received, resolveGroupJoinRequest } = makePipeline({ request: 'missing' });
        pipeline.registerCmd('test.self-invite', () => [selfInviteNotice()]);

        await pipeline.process(packet());

        expect(received).toHaveLength(1);
        // A self-invite never shows up in the UIN-based inbox, so the lookup is skipped.
        expect(resolveGroupJoinRequest).not.toHaveBeenCalled();
    });

    it('lets the card win when it arrives first', async () => {
        const { pipeline, received } = makePipeline({ request: 'missing' });
        pipeline.registerCmd('test.self-invite', () => [selfInviteNotice()]);
        pipeline.registerCmd('test.card', () => [inviteCard()]);

        await pipeline.process({ ...packet(), serviceCmd: 'test.card' });
        await pipeline.process(packet());

        expect(received).toHaveLength(1);
        expect((received[0] as GroupInviteEvent).flag).toBe(`slreq:1:777:${GROUP_ID}:2:0`);
    });

    it('suppresses the notice when the card already delivered the invitation', async () => {
        const { pipeline, received } = makePipeline({ request: 'missing' });
        pipeline.registerCmd('test.self-invite', () => [selfInviteNotice()]);
        pipeline.registerCmd('test.card', () => [inviteCard()]);

        await pipeline.process(packet());
        await pipeline.process({ ...packet(), serviceCmd: 'test.card' });

        expect(received).toHaveLength(1);
        expect((received[0] as GroupInviteEvent).flag).toBe(`invite:${GROUP_ID}:${INVITOR_UID}`);
    });
});
