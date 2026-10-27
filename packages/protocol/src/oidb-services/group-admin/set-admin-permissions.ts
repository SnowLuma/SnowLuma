import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type {
    GroupAdminKickLimit,
    GroupAdminPermissionItem,
    SetGroupAdminPermissionsRequest,
} from '@snowluma/proto-defs/oidb-actions/group-admin-permissions';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface GroupAdminPermissionPatch {
    recallMemberMessage?: boolean;
    kickMember?: boolean;
    /** Required when enabling removal; zero explicitly means unlimited. */
    kickMemberPerDay?: number;
}

export namespace SetAdminPermissions {
    export const command = 0x9c1c;
    export const subCommand = 2;
    export const uinForm = false;
    export type Deps = OidbSender;
    export interface Params extends GroupAdminPermissionPatch {
        groupId: number;
        userId: number;
    }

    export function serialize(_ctx: Deps, p: Params): SetGroupAdminPermissionsRequest {
        if (p.recallMemberMessage === undefined && p.kickMember === undefined) {
            throw new Error('at least one administrator permission must be specified');
        }

        if (p.kickMember === true) {
            if (
                p.kickMemberPerDay === undefined ||
                ![0, 5, 10, 20, 50, 100, 200].includes(p.kickMemberPerDay)
            ) {
                throw new Error(
                    'enabling kick_member requires kick_member_per_day: 0, 5, 10, 20, 50, 100 or 200',
                );
            }
        } else if (p.kickMemberPerDay !== undefined) {
            throw new Error('kick_member_per_day requires kick_member=true');
        }

        const permissions: GroupAdminPermissionItem[] = [];

        if (p.kickMember !== undefined) {
            permissions.push({
                item: 1,
                value: p.kickMember ? 1 : 2,
                extra: p.kickMember
                    ? protobuf_encode<GroupAdminKickLimit>({ maxKickPerDay: p.kickMemberPerDay })
                    : undefined,
            });
        }

        if (p.recallMemberMessage !== undefined) {
            permissions.push({ item: 2, value: p.recallMemberMessage ? 1 : 2 });
        }

        return { groupCode: BigInt(p.groupId), memberUin: BigInt(p.userId), permissions };
    }

    export const deserialize = (_ctx: Deps, _body: OidbEmpty): void => {};

    export const encode = (env: OidbBase<SetGroupAdminPermissionsRequest>): Uint8Array =>
        protobuf_encode<OidbBase<SetGroupAdminPermissionsRequest>>(env);
    export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
        protobuf_decode<OidbBase<OidbEmpty>>(bytes);
    export const invoke = (deps: Deps, params: Params): Promise<void> =>
        invokeOidb(deps, SetAdminPermissions, params);
}
