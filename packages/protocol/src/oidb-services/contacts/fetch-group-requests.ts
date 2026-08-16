// 0x10C0 — fetch pending group-add requests.
//   subCommand 1 = main inbox, 2 = filtered (low-priority) inbox
//
// Current QQ uses the UIN-form envelope for its native list path. The server
// changes user field 1 from a UID string to a numeric UIN when that envelope
// bit changes, so the two forms deliberately have separate decoders below.
// The UID form remains necessary for correlating UID-only real-time pushes.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  OidbBase,
  OidbSvcTrpcTcp0x10C0Response,
  OidbSvcTrpcTcp0x10C0ResponseByUin,
} from '@snowluma/proto-defs/oidb';
import type { OidbGroupRequestList } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

// In OIDB 0x10C0, field 2 directly reflects the operation discriminator used by
// 0x10C8: 1 = user add request, 2 = user invitation, 22 = admin invitation.
// High-level NT UI notification types (e.g. 7 for join application) map directly
// to 1.
export function groupRequestOperationType(notifyType: number): number | null {
  if (notifyType <= 0) return null;
  if (notifyType === 7) return 1;
  return notifyType;
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

  export const deserialize = (_ctx: Deps, body: OidbSvcTrpcTcp0x10C0ResponseByUin): OidbSvcTrpcTcp0x10C0ResponseByUin => body;

  export const encode = (env: OidbBase<OidbGroupRequestList>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupRequestList>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSvcTrpcTcp0x10C0ResponseByUin> =>
    protobuf_decode<OidbBase<OidbSvcTrpcTcp0x10C0ResponseByUin>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<OidbSvcTrpcTcp0x10C0ResponseByUin> =>
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
