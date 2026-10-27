import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    SetGroupAdminReceiveVerifyRequest,
    SetGroupAdminReceiveVerifyResponse,
} from '@snowluma/proto-defs/oidb-actions/group-admin-permissions';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetAdminReceiveVerify {
    export const command = 0x904;
    export const subCommand = 1;
    export const uinForm = true;
    export type Deps = OidbSender;
    export interface Params {
        groupId: number;
        userId: number;
        enable: boolean;
    }

    export const serialize = (_ctx: Deps, p: Params): SetGroupAdminReceiveVerifyRequest => ({
        groupCode: BigInt(p.groupId),
        operation: { adminUins: [BigInt(p.userId)], authority: 1, operate: p.enable ? 1 : 0 },
    });
    export const deserialize = (
        _ctx: Deps,
        body: SetGroupAdminReceiveVerifyResponse,
    ): SetGroupAdminReceiveVerifyResponse => body;
    export const encode = (env: OidbBase<SetGroupAdminReceiveVerifyRequest>): Uint8Array =>
        protobuf_encode<OidbBase<SetGroupAdminReceiveVerifyRequest>>(env);
    export const decode = (bytes: Uint8Array): OidbBase<SetGroupAdminReceiveVerifyResponse> =>
        protobuf_decode<OidbBase<SetGroupAdminReceiveVerifyResponse>>(bytes);

    export async function invoke(deps: Deps, params: Params): Promise<void> {
        const body = await invokeOidb(deps, SetAdminReceiveVerify, params);

        if (body.groupCode !== BigInt(params.groupId)) {
            throw new Error(
                'administrator receive-verify response has a missing or mismatched group',
            );
        }

        if (!body.result?.successfulUins?.includes(BigInt(params.userId))) {
            throw new Error(
                'administrator receive-verify response did not confirm the target member',
            );
        }
    }
}
