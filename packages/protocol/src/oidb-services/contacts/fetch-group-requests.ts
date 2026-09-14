// 0x10C0 — fetch pending group-add requests.
//   subCommand 1 = main inbox, 2 = filtered (low-priority) inbox
//
// Current QQ uses the UIN-form envelope for the native list path, but the
// per-user record still carries a string account on field 1. Decode both
// shapes and merge so neither identifier is dropped. The UID-form request
// remains necessary for correlating UID-only real-time pushes.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  OidbBase,
  OidbSvcTrpcTcp0x10C0Response,
  OidbSvcTrpcTcp0x10C0ResponseByUin,
  OidbSvcTrpcTcp0x10C0ResponseRequest,
  OidbSvcTrpcTcp0x10C0ResponseRequestByUin,
  OidbSvcTrpcTcp0x10C0ResponseUser,
  OidbSvcTrpcTcp0x10C0ResponseUserByUin,
} from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestList } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

// Current QQ's EncodeOperateSysNotify maps the high-level list notification
// type to the discriminator sent by 0x10C8. This table was read directly from
// the current Linux client; keeping the distinction prevents list type 7
// (join request) from being incorrectly sent back as operation type 7.
const GROUP_REQUEST_OPERATION_TYPE = new Map<number, number>([
  [0, 0], [1, 2], [2, 10], [3, 11], [4, 12], [5, 22],
  [6, 35], [7, 1], [8, 3], [9, 6], [10, 7], [11, 13],
  [12, 15], [13, 16], [14, 17], [15, 19], [16, 8], [17, 100],
]);
const GROUP_REQUEST_OPERATION_OUTPUT = new Set(GROUP_REQUEST_OPERATION_TYPE.values());

export function groupRequestOperationType(notifyType: number): number | null {
  const mapped = GROUP_REQUEST_OPERATION_TYPE.get(notifyType);
  if (mapped !== undefined) return mapped;
  // Some list replies already carry the mapped discriminator (e.g. 22).
  if (GROUP_REQUEST_OPERATION_OUTPUT.has(notifyType)) return notifyType;
  return null;
}

export interface DecodedGroupRequestUser {
  uid: string;
  uin: number;
  name: string;
}

export interface DecodedGroupRequest {
  sequence?: bigint;
  eventType?: number;
  state?: number;
  group?: { groupUin?: number; groupName?: string };
  target?: DecodedGroupRequestUser;
  invitor?: DecodedGroupRequestUser;
  operatorUser?: DecodedGroupRequestUser;
  comment?: string;
  operateTransInfo?: Uint8Array;
}

export interface DecodedGroupRequestList {
  requests?: DecodedGroupRequest[];
  field2?: bigint;
  newLatestSeq?: bigint;
  field4?: number;
  field5?: bigint;
  field6?: number;
}

function mergeRequestUser(
  byUin?: OidbSvcTrpcTcp0x10C0ResponseUserByUin,
  byUid?: OidbSvcTrpcTcp0x10C0ResponseUser,
): DecodedGroupRequestUser {
  return {
    uid: byUid?.uid ?? '',
    uin: byUin?.uin ?? 0,
    name: (byUin?.name || byUid?.name) ?? '',
  };
}

function mergeRequestItem(
  byUin?: OidbSvcTrpcTcp0x10C0ResponseRequestByUin,
  byUid?: OidbSvcTrpcTcp0x10C0ResponseRequest,
): DecodedGroupRequest {
  const src = byUin ?? byUid;
  return {
    sequence: src?.sequence,
    eventType: src?.eventType,
    state: src?.state,
    group: src?.group,
    target: mergeRequestUser(byUin?.target, byUid?.target),
    invitor: mergeRequestUser(byUin?.invitor, byUid?.invitor),
    operatorUser: mergeRequestUser(byUin?.operatorUser, byUid?.operatorUser),
    comment: src?.comment ?? '',
    operateTransInfo: src?.operateTransInfo,
  };
}

function mergeRequestList(
  byUin?: OidbSvcTrpcTcp0x10C0ResponseByUin,
  byUid?: OidbSvcTrpcTcp0x10C0Response,
): DecodedGroupRequestList {
  const src = byUin ?? byUid;
  const uinItems = byUin?.requests ?? [];
  const uidItems = byUid?.requests ?? [];
  const count = Math.max(uinItems.length, uidItems.length);
  const requests: DecodedGroupRequest[] = [];
  for (let i = 0; i < count; i++) {
    requests.push(mergeRequestItem(uinItems[i], uidItems[i]));
  }
  return {
    requests,
    field2: src?.field2,
    newLatestSeq: src?.newLatestSeq,
    field4: src?.field4,
    field5: src?.field5,
    field6: src?.field6,
  };
}

export namespace FetchGroupRequests {
  export const command = 0x10C0;
  export const uinForm = true;

  export interface Params {
    /** false → subCmd 1 (main inbox), true → subCmd 2 (filtered). */
    filtered: boolean;
    /** Maximum records in this screen. QQ's own default is 50. */
    count?: number;
    /** Cursor returned by response field 2; zero starts at the newest screen. */
    cursor?: bigint;
  }

  export type Deps = OidbSender;

  export const resolveSubCommand = (p: Params): number => p.filtered ? 2 : 1;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupRequestList => ({
    count: p.count ?? 50,
    field2: p.cursor ?? 0n,
  });

  export const deserialize = (_ctx: Deps, body: DecodedGroupRequestList): DecodedGroupRequestList => body;

  export const encode = (env: OidbBase<OidbGroupRequestList>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupRequestList>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<DecodedGroupRequestList> => {
    const byUin = protobuf_decode<OidbBase<OidbSvcTrpcTcp0x10C0ResponseByUin>>(bytes);
    const byUid = protobuf_decode<OidbBase<OidbSvcTrpcTcp0x10C0Response>>(bytes);
    return {
      ...byUin,
      body: mergeRequestList(byUin.body, byUid.body),
    };
  };

  export const invoke = (deps: Deps, params: Params): Promise<DecodedGroupRequestList> =>
    invokeOidb(deps, FetchGroupRequests, params);
}

/** UID-form compatibility path used only when an incoming push supplies UID
 * but no UIN. It intentionally leaves the envelope's reserved field unset. */
export namespace FetchGroupRequestsByUid {
  export const command = 0x10C0;

  export interface Params {
    filtered: boolean;
    count?: number;
    cursor?: bigint;
  }

  export type Deps = OidbSender;

  export const resolveSubCommand = (p: Params): number => p.filtered ? 2 : 1;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupRequestList => ({
    count: p.count ?? 50,
    field2: p.cursor ?? 0n,
  });

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0x10C0Response): OidbSvcTrpcTcp0x10C0Response => body;

  export const encode = (env: OidbBase<OidbGroupRequestList>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupRequestList>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0x10C0Response> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0x10C0Response>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbSvcTrpcTcp0x10C0Response> =>
    invokeOidb(deps, FetchGroupRequestsByUid, params);
}
