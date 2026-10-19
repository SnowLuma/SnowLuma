import { describe, expect, it, vi } from 'vitest';
import { IncomingPacketPipeline } from '@snowluma/protocol/packet-pipeline';
import { BridgeEventBus } from '@snowluma/protocol/event-bus';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { GroupInviteEvent, QQEventVariant } from '@snowluma/protocol/events';
import type {
    GroupMemberInfo,
    GroupRequestInfo,
    QQGroupInfo,
    UserProfileInfo,
} from '@snowluma/protocol/qq-info';
import type { PacketInfo } from '@snowluma/common/protocol-types';

function makeProfile(uin: number, uid = '', nickname = ''): UserProfileInfo {
    return {
        uin,
        uid,
        nickname,
        remark: '',
        qid: '',
        sex: 'unknown',
        age: 0,
        sign: '',
        avatar: '',
        level: 0,
        qidianMasterFlag: 0,
        qidianCrewFlag: 0,
        qidianCrewFlag2: 0,
    };
}

function makePipeline(
    opts: {
        fetchProfileByUid?: vi.Mock;
        resolveGroupJoinRequest?: vi.Mock;
    } = {},
) {
    const identity = IdentityService.memory('10001');
    const events = new BridgeEventBus();
    const fetchProfileByUid = opts.fetchProfileByUid ?? vi.fn(async () => makeProfile(0));
    identity.setFetcher({
        fetchProfile: async () => makeProfile(0),
        fetchProfileByUid,
    });
    const resolveGroupJoinRequest = opts.resolveGroupJoinRequest ?? vi.fn(async () => request());
    const pipeline = new IncomingPacketPipeline({
        identity,
        events,
        fetchGroupList: vi.fn(async () => {}),
        fetchGroupMemberList: vi.fn(async () => {}),
        resolveGroupJoinRequest,
        rememberGroupInviteCardSequence: vi.fn(() => true),
    });

    const captured: QQEventVariant[] = [];
    events.onAny((event) => {
        captured.push(event as QQEventVariant);
    });

    return {
        identity,
        pipeline,
        events,
        captured,
        fetchProfileByUid,
        resolveGroupJoinRequest,
    };
}

function request(overrides: Partial<GroupRequestInfo> = {}): GroupRequestInfo {
    return {
        groupId: 12345,
        groupName: 'group',
        targetUid: 'u_requester',
        targetUin: 0,
        targetName: '',
        invitorUid: '',
        invitorUin: 0,
        invitorName: '',
        operatorUid: '',
        operatorUin: 0,
        operatorName: '',
        sequence: 42,
        state: 1,
        notifyType: 7,
        eventType: 1,
        comment: 'please',
        filtered: false,
        ...overrides,
    };
}

function requestEvent(overrides: Partial<GroupInviteEvent> = {}): GroupInviteEvent {
    return {
        kind: 'group_invite',
        time: 1,
        selfUin: 10001,
        groupId: 12345,
        fromUin: 0,
        fromUid: 'u_requester',
        subType: 'add',
        message: '',
        flag: 'add:12345:u_requester',
        ...overrides,
    };
}

async function receive(pipeline: IncomingPacketPipeline, event: GroupInviteEvent): Promise<void> {
    pipeline.registerCmd('test.cmd', () => [event]);
    await pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
}

describe('IncomingPacketPipeline / group requests', () => {
    it('resolves an unknown requester before dispatch', async () => {
        const fetchProfileByUid = vi.fn(async () => makeProfile(222, 'u_requester', 'Alice'));
        const { pipeline, captured } = makePipeline({ fetchProfileByUid });
        await receive(pipeline, requestEvent());
        expect(fetchProfileByUid).toHaveBeenCalledWith('u_requester');
        expect(captured).toEqual([
            expect.objectContaining({
                fromUin: 222,
                message: 'please',
                flag: 'slreq:1:42:12345:1:0',
            }),
        ]);
    });

    it('keeps an actionable request when its sender cannot be identified', async () => {
        const { pipeline, captured } = makePipeline();
        await receive(pipeline, requestEvent());
        expect(captured).toEqual([
            expect.objectContaining({
                fromUin: 0,
                flag: 'slreq:1:42:12345:1:0',
            }),
        ]);
    });

    it('fetches the comment even when the requester identity is already known', async () => {
        const { pipeline, captured, resolveGroupJoinRequest, fetchProfileByUid } = makePipeline();
        await receive(pipeline, requestEvent({ fromUin: 222 }));
        expect(resolveGroupJoinRequest).toHaveBeenCalledWith(
            12345,
            'u_requester',
            'add',
            undefined,
        );
        expect(fetchProfileByUid).not.toHaveBeenCalled();
        expect(captured).toEqual([expect.objectContaining({ fromUin: 222, message: 'please' })]);
    });

    it('uses the sender and approval tuple from the matched filtered request', async () => {
        const resolveGroupJoinRequest = vi.fn(async () =>
            request({ targetUin: 222, filtered: true }),
        );
        const { pipeline, captured, fetchProfileByUid } = makePipeline({ resolveGroupJoinRequest });
        await receive(pipeline, requestEvent());
        expect(fetchProfileByUid).not.toHaveBeenCalled();
        expect(captured).toEqual([
            expect.objectContaining({ fromUin: 222, flag: 'slreq:1:42:12345:1:1' }),
        ]);
    });

    it('matches an invitation approval by inviter and invitee', async () => {
        const resolveGroupJoinRequest = vi.fn(async () =>
            request({
                invitorUid: 'u_inviter',
                invitorUin: 456,
                targetUid: 'u_invitee',
                targetUin: 789,
                eventType: 22,
                notifyType: 5,
            }),
        );
        const { pipeline, captured } = makePipeline({ resolveGroupJoinRequest });
        await receive(
            pipeline,
            requestEvent({ subType: 'invite', fromUid: 'u_inviter', invitedUid: 'u_invitee' }),
        );
        expect(resolveGroupJoinRequest).toHaveBeenCalledWith(
            12345,
            'u_inviter',
            'invite',
            'u_invitee',
        );
        expect(captured).toEqual([
            expect.objectContaining({
                fromUin: 456,
                invitedUin: 789,
                invitedUid: 'u_invitee',
                flag: 'slreq:1:42:12345:22:0',
            }),
        ]);
    });

    it('leaves self invitations to the card without querying or waiting', async () => {
        const { pipeline, captured, resolveGroupJoinRequest, fetchProfileByUid } = makePipeline();
        await receive(pipeline, requestEvent({ subType: 'invite', invitedUin: 10001 }));
        expect(captured).toEqual([]);
        expect(resolveGroupJoinRequest).not.toHaveBeenCalled();
        expect(fetchProfileByUid).not.toHaveBeenCalled();
    });

    it('does not substitute a list sequence for the self-invite card sequence', async () => {
        const resolveGroupJoinRequest = vi.fn(async () =>
            request({ eventType: 2, targetUin: 10001 }),
        );
        const { pipeline, captured } = makePipeline({ resolveGroupJoinRequest });
        await receive(pipeline, requestEvent({ subType: 'invite' }));
        expect(captured).toEqual([]);
    });

    it.each(['missing', 'failed'])(
        'does not emit an incomplete request after a %s lookup',
        async (outcome) => {
            const resolveGroupJoinRequest =
                outcome === 'missing'
                    ? vi.fn(async () => null)
                    : vi.fn(async () => {
                          throw new Error('lookup failed');
                      });
            const { pipeline, captured, fetchProfileByUid } = makePipeline({
                resolveGroupJoinRequest,
            });
            await receive(pipeline, requestEvent());
            expect(captured).toEqual([]);
            expect(resolveGroupJoinRequest).toHaveBeenCalledOnce();
            expect(fetchProfileByUid).not.toHaveBeenCalled();
        },
    );

    it('does not treat a requester UIN equal to the group number as unresolved', async () => {
        const { pipeline, captured, identity, fetchProfileByUid } = makePipeline();
        await receive(pipeline, requestEvent({ fromUin: 12345 }));
        expect(fetchProfileByUid).not.toHaveBeenCalled();
        expect(captured[0]).toMatchObject({ fromUin: 12345 });
        expect(identity.findUinByUid('u_requester')).toBe(12345);
    });

    it('rejects a request without its requester UID', async () => {
        const { pipeline, captured, resolveGroupJoinRequest } = makePipeline();
        await receive(pipeline, requestEvent({ fromUid: '' }));
        expect(captured).toEqual([]);
        expect(resolveGroupJoinRequest).not.toHaveBeenCalled();
    });
});

describe('IncomingPacketPipeline / friend message identity', () => {
    it('preserves the exact UID/UIN pair carried by an incoming C2C message', () => {
        const { identity, pipeline } = makePipeline();
        pipeline.registerCmd('test.cmd', () => [
            {
                kind: 'friend_message',
                time: 1700000000,
                selfUin: 10001,
                senderUin: 22222,
                senderUid: 'u_peer_exact',
                senderNick: 'peer',
                msgSeq: 1,
                msgId: 2,
                elements: [{ type: 'text', text: 'hi' }],
            },
        ]);

        pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);

        expect(identity.findUidByUin(22222)).toBe('u_peer_exact');
        expect(identity.findUinByUid('u_peer_exact')).toBe(22222);
    });
});

describe('IncomingPacketPipeline / #1 group card self-heal', () => {
    function makeGroupMsgPipeline() {
        const identity = IdentityService.memory('10001');
        const events = new BridgeEventBus();
        const pipeline = new IncomingPacketPipeline({
            identity,
            events,
            fetchGroupList: vi.fn(async () => {}),
            fetchGroupMemberList: vi.fn(async () => {}),
            resolveGroupJoinRequest: vi.fn(async () => null),
            rememberGroupInviteCardSequence: vi.fn(() => true),
        });
        return { identity, pipeline };
    }

    const groupMsg = (senderCard: string): QQEventVariant =>
        ({
            kind: 'group_message',
            groupName: '',
            time: 1,
            selfUin: 10001,
            groupId: 9999,
            senderUin: 222,
            senderNick: 'BaseNick',
            senderCard,
            senderRole: 'member',
            msgSeq: 1,
            msgId: 1,
            elements: [{ type: 'text', text: 'hi' }],
        }) as QQEventVariant;

    const member = (card: string) => ({
        uin: 222,
        uid: '',
        nickname: 'BaseNick',
        card,
        role: 'member',
        level: 0,
        title: '',
        joinTime: 0,
        lastSentTime: 0,
        shutUpTime: 0,
    });

    it('updates the cached member card when a group_message carries a fresher card', () => {
        const { identity, pipeline } = makeGroupMsgPipeline();
        identity.rememberGroups([
            {
                groupId: 9999,
                groupName: 'g',
                memberCount: 1,
                members: new Map(),
            } as unknown as Parameters<typeof identity.rememberGroups>[0][0],
        ]);
        identity.rememberGroupMembers(9999, [member('StaleCard')]);
        pipeline.registerCmd('test.cmd', () => [groupMsg('FreshCard')]);
        pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
        expect(identity.findGroupMember(9999, 222)?.card).toBe('FreshCard');
    });

    it('does not write when the card is unchanged (gated)', () => {
        const { identity, pipeline } = makeGroupMsgPipeline();
        identity.rememberGroups([
            {
                groupId: 9999,
                groupName: 'g',
                memberCount: 1,
                members: new Map(),
            } as unknown as Parameters<typeof identity.rememberGroups>[0][0],
        ]);
        identity.rememberGroupMembers(9999, [member('SameCard')]);
        const spy = vi.spyOn(identity, 'updateGroupMember');
        pipeline.registerCmd('test.cmd', () => [groupMsg('SameCard')]);
        pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
        expect(spy).not.toHaveBeenCalled();
    });

    it('does not create an entry for an uncached member (no self-heal without a base)', () => {
        const { identity, pipeline } = makeGroupMsgPipeline();
        const spy = vi.spyOn(identity, 'updateGroupMember');
        pipeline.registerCmd('test.cmd', () => [groupMsg('SomeCard')]);
        pipeline.process({ serviceCmd: 'test.cmd' } as PacketInfo);
        expect(spy).not.toHaveBeenCalled();
        expect(identity.findGroupMember(9999, 222)).toBeNull();
    });
});

describe('IncomingPacketPipeline / group_card_change from message traffic', () => {
    const GROUP = 123456789;

    function member(card: string): GroupMemberInfo {
        return {
            uin: 22222,
            uid: 'u_member',
            nickname: 'nick',
            card,
            role: 'member',
            level: 0,
            title: '',
            joinTime: 0,
            lastSentTime: 0,
            shutUpTime: 0,
        };
    }

    function setup(cachedCard: string) {
        const identity = IdentityService.memory('10001');
        identity.rememberGroups([
            {
                groupId: GROUP,
                groupName: 'g',
                remark: '',
                memberCount: 1,
                memberMax: 500,
                members: new Map([[22222, member(cachedCard)]]),
            } as QQGroupInfo,
        ]);
        const events = new BridgeEventBus();
        const pipeline = new IncomingPacketPipeline({
            identity,
            events,
            fetchGroupList: vi.fn(async () => {}),
            fetchGroupMemberList: vi.fn(async () => {}),
            resolveGroupJoinRequest: vi.fn(async () => null),
            rememberGroupInviteCardSequence: vi.fn(() => true),
        });
        const captured: QQEventVariant[] = [];
        events.onAny((e) => captured.push(e as QQEventVariant));
        return { pipeline, captured };
    }

    function groupMsg(card: string): QQEventVariant {
        return {
            kind: 'group_message',
            groupName: '',
            time: 1700000000,
            selfUin: 10001,
            groupId: GROUP,
            senderUin: 22222,
            senderNick: 'nick',
            senderCard: card,
            senderRole: 'member',
            msgSeq: 1,
            msgId: 1,
            elements: [],
        } as QQEventVariant;
    }

    const pkt = (): PacketInfo => ({
        pid: 1,
        uin: '10001',
        serviceCmd: 'test.cmd',
        seqId: 1,
        retCode: 0,
        fromClient: false,
        body: new Uint8Array(),
    });

    it('emits group_card_change when a known member card changes', () => {
        const { pipeline, captured } = setup('OldCard');
        pipeline.registerCmd('test.cmd', () => [groupMsg('NewCard')]);
        pipeline.process(pkt());
        const ev = captured.find((e) => e.kind === 'group_card_change');
        expect(ev).toBeTruthy();
        expect((ev as Extract<QQEventVariant, { kind: 'group_card_change' }>).cardOld).toBe(
            'OldCard',
        );
        expect((ev as Extract<QQEventVariant, { kind: 'group_card_change' }>).cardNew).toBe(
            'NewCard',
        );
        expect((ev as Extract<QQEventVariant, { kind: 'group_card_change' }>).userUin).toBe(22222);
    });

    it('does NOT emit when the card is unchanged', () => {
        const { pipeline, captured } = setup('SameCard');
        pipeline.registerCmd('test.cmd', () => [groupMsg('SameCard')]);
        pipeline.process(pkt());
        expect(captured.some((e) => e.kind === 'group_card_change')).toBe(false);
    });

    it('does NOT fabricate a change on first contact (no cached card)', () => {
        const { pipeline, captured } = setup('');
        pipeline.registerCmd('test.cmd', () => [groupMsg('SomeCard')]);
        pipeline.process(pkt());
        expect(captured.some((e) => e.kind === 'group_card_change')).toBe(false);
    });
});
