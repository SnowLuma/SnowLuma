import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    GetGroupAdminPermissionsRequest,
    GetGroupAdminPermissionsResponse,
    GroupAdminKickLimit,
} from '@snowluma/proto-defs/oidb-actions/group-admin-permissions';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface AdminPermissionsSnapshot {
    recallMemberMessage: boolean | null;
    kickMember: boolean | null;
    kickMemberPerDay: number | null;
}

export namespace GetAdminPermissions {
    export const command = 0x9164;
    export const subCommand = 2;
    export const uinForm = true;
    export type Deps = OidbSender;
    export interface Params {
        groupId: number;
        userId: number;
    }

    export const serialize = (_ctx: Deps, p: Params): GetGroupAdminPermissionsRequest => ({
        groupCode: BigInt(p.groupId),
        memberUins: [BigInt(p.userId)],
        filter: { permissions: new Uint8Array([1]) },
    });
    export const deserialize = (
        _ctx: Deps,
        body: GetGroupAdminPermissionsResponse,
    ): GetGroupAdminPermissionsResponse => body;
    export const encode = (env: OidbBase<GetGroupAdminPermissionsRequest>): Uint8Array =>
        protobuf_encode<OidbBase<GetGroupAdminPermissionsRequest>>(env);
    export const decode = (bytes: Uint8Array): OidbBase<GetGroupAdminPermissionsResponse> =>
        protobuf_decode<OidbBase<GetGroupAdminPermissionsResponse>>(bytes);

    export async function invoke(deps: Deps, params: Params): Promise<AdminPermissionsSnapshot> {
        const body = await invokeOidb(deps, GetAdminPermissions, params);

        if (body.groupCode !== BigInt(params.groupId)) {
            throw new Error('administrator permissions response has a missing or mismatched group');
        }

        const members = (body.members ?? []).filter(
            (member) => member.memberUin === BigInt(params.userId),
        );

        if (members.length !== 1) {
            throw new Error(
                'administrator permissions response must contain exactly one matching member',
            );
        }

        const snapshot: AdminPermissionsSnapshot = {
            recallMemberMessage: null,
            kickMember: null,
            kickMemberPerDay: null,
        };
        const seen = new Set<number>();

        for (const permission of members[0]!.ext?.permissions?.items ?? []) {
            const id = permission.item;

            if (id !== 1 && id !== 2) {
                continue;
            }

            if (seen.has(id)) {
                throw new Error(`administrator permissions response contains duplicate item ${id}`);
            }

            seen.add(id);
            const value = permission.value ?? 0;

            if (value !== 0 && value !== 1 && value !== 2) {
                throw new Error(`administrator permission ${id} has unsupported value ${value}`);
            }

            // Zero or an absent item does not establish an effective permission.
            const enabled = value === 0 ? null : value === 1;

            if (id === 2) {
                snapshot.recallMemberMessage = enabled;
            } else {
                snapshot.kickMember = enabled;

                if (enabled) {
                    const limit = protobuf_decode<GroupAdminKickLimit>(
                        permission.extra ?? new Uint8Array(0),
                    );
                    snapshot.kickMemberPerDay = limit.maxKickPerDay ?? 0;
                }
            }
        }

        return snapshot;
    }
}
