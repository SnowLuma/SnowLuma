import { afterEach, describe, expect, it, vi } from 'vitest';
import { Bridge } from '@snowluma/core/bridge';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { MSG_PUSH_CMD } from '@snowluma/protocol/msg-push';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { PushMsg } from '@snowluma/proto-defs/message';
import type { GroupInvite } from '@snowluma/proto-defs/notify';
import type { OidbBase, OidbSvcTrpcTcp0x10C0Response } from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestAction } from '@snowluma/proto-defs/oidb-actions/base';
import { getGroupSystemMessages } from '../src/modules/contact-actions';
import { handleGroupAddRequest } from '../src/modules/request-actions';

const bridges: Bridge[] = [];

afterEach(async () => {
    await Promise.all(bridges.splice(0).map((bridge) => bridge.dispose()));
});

function setup(filtered = false, overrides: { targetUid?: string; state?: number } = {}) {
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
    const operateTransInfo = Uint8Array.from([8, 42, 16, 231, 7, 24, 2]);
    const record = {
        sequence: 42n,
        eventType: 2,
        state: overrides.state ?? 1,
        group: { groupUin: 999, groupName: 'group' },
        target: { uid: overrides.targetUid ?? 'u_self', name: 'bot' },
        invitor: { uid: 'u_inviter', name: 'inviter' },
        operateTransInfo,
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
    const flags: string[] = [];
    bridge.events.on('group_invite', (event) => flags.push(event.flag));
    const notice = () =>
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
                        contentHead: { msgType: 87, timestamp: 1 },
                        body: {
                            msgContent: protobuf_encode<GroupInvite>({
                                groupUin: 999,
                                invitorUid: 'u_inviter',
                            }),
                        },
                    },
                    status: 0,
                }),
            ),
        });
    return { bridge, send, flags, notice, operateTransInfo };
}

describe('non-friend group invitations', () => {
    it.each([
        { approve: true, filtered: false },
        { approve: false, filtered: true },
    ])('handles an emitted flag through the real codecs: %j', async ({ approve, filtered }) => {
        const { bridge, send, flags, notice, operateTransInfo } = setup(filtered);
        await notice();
        expect(flags).toEqual(['invite:999:u_inviter']);
        await handleGroupAddRequest(bridge, flags[0]!, approve, '');
        const approval = send.mock.calls.find(([cmd]) => cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'))!;
        expect(approval[0]).toBe(`OidbSvcTrpcTcp.0x10c8_${filtered ? 2 : 1}`);
        const wire = protobuf_decode<OidbBase<OidbGroupRequestAction>>(approval[1]);
        expect(wire.body).toMatchObject({
            accept: approve ? 1 : 2,
            body: { sequence: 42n, groupUin: 999, eventType: 10, message: ' ', operateTransInfo },
        });
        expect(
            await bridge.apis.contacts.resolveGroupJoinRequest(
                999,
                'u_inviter',
                'invite',
                'u_self',
            ),
        ).toMatchObject({ notifyType: 2, eventType: 10 });
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
                flag: 'slreq:1:42:999:10:0',
            }),
        ]);
        await handleGroupAddRequest(bridge, String(rows[0]!.flag), true, '');
        const approval = send.mock.calls.find(([cmd]) => cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'))!;
        const wire = protobuf_decode<OidbBase<OidbGroupRequestAction>>(approval[1]);
        expect(wire.body?.body).toMatchObject({ eventType: 10, operateTransInfo });
    });

    it.each([{ targetUid: 'u_other' }, { state: 2 }])(
        'rejects a mismatched or processed invitation: %j',
        async (overrides) => {
            const { bridge, send, flags, notice } = setup(false, overrides);
            await notice();
            await expect(handleGroupAddRequest(bridge, flags[0]!, true, '')).rejects.toThrow(
                'matching group request not found',
            );
            expect(send.mock.calls.some(([cmd]) => cmd.startsWith('OidbSvcTrpcTcp.0x10c8_'))).toBe(
                false,
            );
        },
    );
});
