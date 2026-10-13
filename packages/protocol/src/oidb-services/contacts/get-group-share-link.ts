import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
    OidbGroupShareLinkRequest,
    OidbGroupShareLinkResponse,
} from '@snowluma/proto-defs/oidb-actions/group-share-link';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetGroupShareLink {
    export const command = 0x9060;
    export const subCommand = 3;
    export const uinForm = true;

    export interface Params {
        groupId: number;
        needShortUrl: boolean;
        srcId: number;
        additionalParam: string;
    }

    export type Deps = OidbSender;

    export const serialize = (_ctx: Deps, p: Params): OidbGroupShareLinkRequest => ({
        type: 2n,
        group: {
            groupCode: BigInt(p.groupId),
            additionalParam: p.additionalParam,
            needShortUrl: p.needShortUrl,
        },
    });

    export const deserialize = (_ctx: Deps, body: OidbGroupShareLinkResponse): string => {
        const url = body.group?.url;

        if (!url?.trim()) {
            throw new Error('group share link response did not include a URL');
        }

        return url;
    };

    export const encode = (env: OidbBase<OidbGroupShareLinkRequest>): Uint8Array =>
        protobuf_encode<OidbBase<OidbGroupShareLinkRequest>>(env);

    export const decode = (bytes: Uint8Array): OidbBase<OidbGroupShareLinkResponse> =>
        protobuf_decode<OidbBase<OidbGroupShareLinkResponse>>(bytes);

    export const invoke = (deps: Deps, params: Params): Promise<string> =>
        invokeOidb(deps, GetGroupShareLink, params);
}
