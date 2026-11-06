import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '@snowluma/core/bridge';
import { IdentityService } from '@snowluma/protocol/identity-service';
import type { GroupInviteEvent } from '@snowluma/protocol/events';
import { MSG_PUSH_CMD } from '@snowluma/protocol/msg-push';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { GroupInvitation, GroupInvite, GroupJoin } from '@snowluma/proto-defs/notify';
import type {
    OidbBase,
    OidbSvcTrpcTcp0x10C0Response,
    OidbSvcTrpcTcp0x10C0ResponseRequest,
} from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestAction } from '@snowluma/proto-defs/oidb-actions/base';
import { convertEvent } from '../src/event-converter';
import { getGroupSystemMessages } from '../src/modules/contact-actions';
import { handleGroupAddRequest } from '../src/modules/request-actions';

const bridges: Bridge[] = [];

afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
});

function setup(filtered = false, overrides: OidbSvcTrpcTcp0x10C0ResponseRequest = {}) {
    const bridge = new Bridge(IdentityService.memory('10001'));
    bridges.push(bridge);
    bridge.identity.setSelfProfile({
        uin: 10001,
        uid: 'u_self',
        nickname: 'bot',
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
    });
    bridge.identity.rememberRequestIdentity({ groupId: 999, uid: 'u_self', uin: 10001 });
    bridge.identity.rememberRequestIdentity({ groupId: 999, uid: 'u_inviter', uin: 456 });
    const record = {
        sequence: 42n,
        eventType: 2,
        state: 1,
        group: { groupUin: 999, groupName: 'group' },
        target: { uid: 'u_self', name: 'bot' },
        invitor: { uid: 'u_inviter', name: 'inviter' },
        operateTransInfo: Uint8Array.from([8, 42, 16, 231, 7, 24, 2]),
        ...overrides,
    };
    const send = vi.spyOn(bridge, 'sendRawPacket').mockImplementation(async (cmd) => {
        let responseData = Buffer.alloc(0);

        if (cmd.startsWith('OidbSvcTrpcTcp.0x10c0_')) {
            responseData = Buffer.from(
                protobuf_encode<OidbBase<OidbSvcTrpcTcp0x10C0Response>>({
                    body: { requests: cmd.endsWith(filtered ? '_2' : '_1') ? [record] : [] },
                }),
            );
        } else if (!cmd.startsWith('OidbSvcTrpcTcp.0x10c8_')) {
            throw new Error(`unexpected request: ${cmd}`);
        }

        return { success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData };
    });
    const events: GroupInviteEvent[] = [];
    bridge.events.on('group_invite', (event) => events.push(event));
    const notice = (
        msgType = 87,
        msgContent = protobuf_encode<GroupInvite>({ groupUin: 999, invitorUid: 'u_inviter' }),
    ) =>
        bridge.onPacket({
            pid: 1,
            uin: '10001',
            serviceCmd: MSG_PUSH_CMD,
            seqId: 1,
            retCode: 0,
            fromClient: false,
            body: Buffer.from(
                protobuf_encode<PushMsg>({
                    message: {
                        contentHead: { msgType, timestamp: 1 },
                        body: { msgContent },
                    },
                    status: 0,
                }),
            ),
        });
    return { bridge, send, events, notice, operateTransInfo: record.operateTransInfo };
}

describe('group join requests', () => {
    it.each([false, true])(
        'reports and handles a join from the inbox (filtered=%s)',
        async (filtered) => {
            const { bridge, send, events, notice, operateTransInfo } = setup(filtered, {
                eventType: 1,
                target: { uid: 'u_applicant', name: 'applicant' },
                invitor: undefined,
                comment: 'please let me in',
                operateTransInfo: Uint8Array.from([8, 42, 16, 231, 7, 24, 1]),
            });
            bridge.identity.rememberRequestIdentity({ groupId: 999, uid: 'u_applicant', uin: 123 });
            await notice(
                84,
                protobuf_encode<GroupJoin>({ groupUin: 999, targetUid: 'u_applicant' }),
            );

            expect(events).toHaveLength(1);
            const flag = `slreq:1:42:999:1:${filtered ? 1 : 0}`;
            const event = await convertEvent(
                {
                    selfId: 10001,
                    imageUrlResolver: null,
                    mediaUrlResolver: null,
                    messageIdResolver: null,
                    mediaSegmentSink: null,
                },
                events[0]!,
            );
            expect(event).toMatchObject({
                post_type: 'request',
                request_type: 'group',
                sub_type: 'add',
                group_id: 999,
                user_id: 123,
                comment: 'please let me in',
                flag,
            });
            expect(await getGroupSystemMessages(bridge, { onlyPending: true })).toEqual([
                expect.objectContaining({ requester_uin: 123, requester_nick: 'applicant', flag }),
            ]);

            await handleGroupAddRequest(bridge, events[0]!.flag, true, '');
            const approvals = send.mock.calls.filter(([cmd]) =>
                cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'),
            );
            expect(approvals).toHaveLength(1);
            const [cmd, bytes] = approvals[0]!;
            expect(cmd).toBe(`OidbSvcTrpcTcp.0x10c8_${filtered ? 2 : 1}`);
            expect(protobuf_decode<OidbBase<OidbGroupRequestAction>>(bytes).body).toMatchObject({
                accept: 1,
                body: { sequence: 42n, groupUin: 999, eventType: 1, operateTransInfo },
            });
        },
    );

    it.each([7, 10, 5])('does not report another wire type (%i) as a join', async (eventType) => {
        const { bridge, events, notice } = setup(false, { eventType });
        await notice(84, protobuf_encode<GroupJoin>({ groupUin: 999, targetUid: 'u_self' }));
        expect(events).toEqual([]);
        expect(await getGroupSystemMessages(bridge)).toEqual([]);
    });

    it.each(['42', 'slreq:1:42:999:1:0'])(
        'refuses an unknown inbox type for flag %s',
        async (flag) => {
            const { bridge, send } = setup(false, { eventType: 5 });
            await expect(handleGroupAddRequest(bridge, flag, true, '')).rejects.toThrow(
                'unsupported group request type',
            );
            expect(send.mock.calls.some(([cmd]) => cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'))).toBe(
                false,
            );
        },
    );
});

describe('non-friend group invitations', () => {
    it.each([
        { approve: true, filtered: false },
        { approve: false, filtered: true },
    ])('handles an emitted flag through the real codecs: %j', async ({ approve, filtered }) => {
        const { bridge, send, events, notice, operateTransInfo } = setup(filtered);
        await notice();
        expect(events).toEqual([expect.objectContaining({ flag: 'invite:999:u_inviter' })]);
        await handleGroupAddRequest(bridge, events[0]!.flag, approve, '');
        const approval = send.mock.calls.find(([cmd]) => cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'))!;
        expect(approval[0]).toBe(`OidbSvcTrpcTcp.0x10c8_${filtered ? 2 : 1}`);
        const wire = protobuf_decode<OidbBase<OidbGroupRequestAction>>(approval[1]);
        expect(wire.body).toMatchObject({
            accept: approve ? 1 : 2,
            body: { sequence: 42n, groupUin: 999, eventType: 2, message: ' ', operateTransInfo },
        });
        expect(
            await bridge.apis.contacts.resolveGroupJoinRequest(
                999,
                'u_inviter',
                'invite',
                'u_self',
            ),
        ).toMatchObject({ notifyType: 1, eventType: 2 });
    });

    it('lists the inviter and returns a flag that can approve the same invitation', async () => {
        const { bridge, send, operateTransInfo } = setup();
        const rows = await getGroupSystemMessages(bridge);
        expect(rows).toEqual([
            expect.objectContaining({
                group_id: 999,
                requester_uin: 456,
                requester_nick: 'inviter',
                checked: false,
                flag: 'slreq:1:42:999:2:0',
            }),
        ]);
        await handleGroupAddRequest(bridge, String(rows[0]!.flag), true, '');
        const approval = send.mock.calls.find(([cmd]) => cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'))!;
        const wire = protobuf_decode<OidbBase<OidbGroupRequestAction>>(approval[1]);
        expect(wire.body?.body).toMatchObject({ eventType: 2, operateTransInfo });
    });

    it('corrects the type in an older invitation flag from the current inbox', async () => {
        const { bridge, send, operateTransInfo } = setup(true);
        await handleGroupAddRequest(bridge, 'slreq:1:42:999:10:0', true, '');
        const approvals = send.mock.calls.filter(([cmd]) =>
            cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'),
        );
        expect(approvals).toHaveLength(1);
        const [cmd, bytes] = approvals[0]!;
        expect(cmd).toBe('OidbSvcTrpcTcp.0x10c8_2');
        expect(protobuf_decode<OidbBase<OidbGroupRequestAction>>(bytes).body?.body).toMatchObject({
            sequence: 42n,
            groupUin: 999,
            eventType: 2,
            operateTransInfo,
        });
    });

    it.each([{ target: { uid: 'u_other' } }, { state: 2 }, { eventType: 10 }])(
        'requires a pending invitation to this account: %j',
        async (overrides) => {
            const { bridge, send, events, notice } = setup(false, overrides);
            await notice();
            await expect(handleGroupAddRequest(bridge, events[0]!.flag, true, '')).rejects.toThrow(
                'matching group request not found',
            );
            expect(send.mock.calls.some(([cmd]) => cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'))).toBe(
                false,
            );
        },
    );
});

describe('invitations awaiting administrator approval', () => {
    it('keeps the applicant, inviter and approval type through the real codecs', async () => {
        const { bridge, send, events, notice, operateTransInfo } = setup(true, {
            eventType: 22,
            target: { uid: 'u_applicant', name: 'applicant' },
            comment: 'invited to join',
            operateTransInfo: Uint8Array.from([8, 42, 16, 231, 7, 24, 22]),
        });
        bridge.identity.rememberRequestIdentity({ groupId: 999, uid: 'u_applicant', uin: 123 });
        await notice(
            525,
            protobuf_encode<GroupInvitation>({
                cmd: 87,
                info: {
                    inner: { groupUin: 999, invitorUid: 'u_inviter', targetUid: 'u_applicant' },
                },
            }),
        );
        expect(events).toEqual([
            expect.objectContaining({
                subType: 'invite',
                fromUin: 456,
                invitedUin: 123,
                flag: 'slreq:1:42:999:22:1',
            }),
        ]);
        expect(await getGroupSystemMessages(bridge)).toEqual([
            expect.objectContaining({
                requester_uin: 123,
                invitor_uin: 456,
                flag: events[0]!.flag,
            }),
        ]);
        await handleGroupAddRequest(bridge, events[0]!.flag, false, 'declined');
        const approvals = send.mock.calls.filter(([cmd]) =>
            cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'),
        );
        expect(approvals).toHaveLength(1);
        const [cmd, bytes] = approvals[0]!;
        expect(cmd).toBe('OidbSvcTrpcTcp.0x10c8_2');
        expect(protobuf_decode<OidbBase<OidbGroupRequestAction>>(bytes).body).toMatchObject({
            accept: 2,
            body: {
                sequence: 42n,
                groupUin: 999,
                eventType: 22,
                message: 'declined',
                operateTransInfo,
            },
        });
    });
});
