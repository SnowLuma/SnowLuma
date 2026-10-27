import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    GetGroupAdminReceiveVerifyRequest,
    GetGroupAdminReceiveVerifyResponse,
} from '@snowluma/proto-defs/oidb-actions/group-admin-permissions';
import type { BridgeContext } from '../../bridge-context';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetAdminReceiveVerify {
    export const command = 0xfe7;
    export const subCommand = 4;
    export const uinForm = false;
    export type Deps = OidbSender & Pick<BridgeContext, 'resolveUserUid'>;
    export interface Params {
        groupId: number;
        userId: number;
    }

    interface RequestParams {
        groupId: number;
        userUid: string;
    }

    export const serialize = (_ctx: Deps, p: RequestParams): GetGroupAdminReceiveVerifyRequest => ({
        groupCode: BigInt(p.groupId),
        field2: 3,
        field3: 0,
        filter: { memberFlagExt: 1 },
        members: [{ uid: p.userUid }],
    });
    export const deserialize = (
        _ctx: Deps,
        body: GetGroupAdminReceiveVerifyResponse,
    ): GetGroupAdminReceiveVerifyResponse => body;
    export const encode = (env: OidbBase<GetGroupAdminReceiveVerifyRequest>): Uint8Array =>
        protobuf_encode<OidbBase<GetGroupAdminReceiveVerifyRequest>>(env);
    export const decode = (bytes: Uint8Array): OidbBase<GetGroupAdminReceiveVerifyResponse> =>
        protobuf_decode<OidbBase<GetGroupAdminReceiveVerifyResponse>>(bytes);

    export async function invoke(deps: Deps, params: Params): Promise<boolean | null> {
        const userUid = await deps.resolveUserUid(params.userId, params.groupId);
        const body = await invokeOidb(deps, GetAdminReceiveVerify, {
            groupId: params.groupId,
            userUid,
        });

        if (body.groupCode !== BigInt(params.groupId)) {
            throw new Error(
                'administrator receive-verify response has a missing or mismatched group',
            );
        }

        const members = (body.members ?? []).filter((member) => member.identity?.uid === userUid);

        if (members.length !== 1) {
            throw new Error(
                'administrator receive-verify response must contain exactly one matching member',
            );
        }

        const member = members[0]!;
        const returnedUin = member.identity?.uin;

        if (returnedUin != null && returnedUin !== BigInt(params.userId)) {
            throw new Error('administrator receive-verify response has a mismatched member UIN');
        }

        // Missing data must remain unknown; an explicit zero is a known enabled state.
        return member.memberFlagExt == null ? null : (member.memberFlagExt & 64) === 0;
    }
}
