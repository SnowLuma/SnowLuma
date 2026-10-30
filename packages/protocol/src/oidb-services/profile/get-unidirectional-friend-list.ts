// This service uses its own JSON transport rather than the standard OIDB envelope.
import type { Oidb0xe17Req, Oidb0xe17Resp } from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '../../bridge-context';
import { OidbError, type OidbSender } from '../../oidb-service';
import { requirePacketResponse } from '../../msg-push/packet-response';

export interface UnidirectionalFriendEntry {
    [key: string]: import('@snowluma/common/json').JsonValue;
}

function isObject(value: unknown): value is UnidirectionalFriendEntry {
    return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export namespace GetUnidirectionalFriendList {
    export const command = 0xe17;
    export const subCommand = 0;

    export const wireName = (): string => 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0';

    export interface Params {}

    export type Deps = OidbSender & Pick<BridgeContext, 'identity'>;

    export const serialize = (ctx: Deps, _p: Params): Oidb0xe17Req => {
        const reqObj = {
            uint64_uin: String(ctx.identity.uin),
            uint64_top: 0,
            uint32_req_num: 99,
            bytes_cookies: '',
        };
        return { subCommand, jsonBody: JSON.stringify(reqObj) };
    };

    export const deserialize = (_ctx: Deps, body: Oidb0xe17Resp): UnidirectionalFriendEntry[] => {
        if (body.errorCode) {
            throw new OidbError(body.errorCode, body.errorMessage ?? '', command, subCommand);
        }

        if (!body || !body.jsonBody) {
            throw new Error('get unidirectional friend list empty');
        }

        const parsed: unknown = JSON.parse(body.jsonBody);

        if (!isObject(parsed)) {
            throw new Error('get unidirectional friend list invalid response');
        }

        if (parsed.ActionStatus !== 'OK' || parsed.ErrorCode !== 0) {
            const code = typeof parsed.ErrorCode === 'number' ? parsed.ErrorCode : 'missing';
            const message = typeof parsed.ErrorInfo === 'string' ? parsed.ErrorInfo : '';
            throw new Error(`get unidirectional friend list failed: ${code} ${message}`.trim());
        }

        if (!Array.isArray(parsed.rpt_block_list) || !parsed.rpt_block_list.every(isObject)) {
            throw new Error('get unidirectional friend list invalid block list');
        }

        return parsed.rpt_block_list;
    };

    export const encode = (request: Oidb0xe17Req): Uint8Array =>
        protobuf_encode<Oidb0xe17Req>(request);

    export const decode = (bytes: Uint8Array): Oidb0xe17Resp =>
        protobuf_decode<Oidb0xe17Resp>(bytes);

    export const invoke = async (deps: Deps): Promise<UnidirectionalFriendEntry[]> => {
        const result = await deps.sendRawPacket(wireName(), encode(serialize(deps, {})));
        return deserialize(deps, decode(requirePacketResponse(result, wireName())));
    };
}
