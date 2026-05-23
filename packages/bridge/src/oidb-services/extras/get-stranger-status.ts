// 0xFE1_2 — fetch the stranger's status (online / away / busy /
// invisible). Same OIDB cmd as fetchUserProfile but a different
// request shape (only key 27372 = status, no other property keys),
// and we decode the ext-bigint status word into napcat's
// (status × 10, ext_status) pair.
//
// `uinForm` is set so the server takes the UIN-form validation path;
// without it newer NTQQ rejects with `[oidb] one of uid/openid is
// invaild`. Same flag fetchUserProfile uses.
//
// On any transport / decode failure the deserialize step is bypassed
// — the facade swallows the namespace-level exception and surfaces
// `null` so callers get a clean retcode.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbStrangerStatusReq, OidbStrangerStatusResp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface StrangerStatus {
  status: number;
  ext_status: number;
}

export namespace GetStrangerStatus {
  export const command = 0xFE1;
  export const subCommand = 2;
  export const uinForm = true;

  export interface Params {
    uin: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbStrangerStatusReq => ({
    uin: p.uin,
    key: [{ key: 27372 }],
  });

  export const deserialize = (_ctx: Deps, body: OidbStrangerStatusResp): StrangerStatus | null => {
    const raw = body.data?.status?.value;
    if (raw === undefined || raw === null) return null;
    const extBig = typeof raw === 'bigint' ? raw : BigInt(raw as any);
    if (extBig <= 10n) {
      return { status: Number(extBig) * 10, ext_status: 0 };
    }
    const status = Number((extBig & 0xff00n) + ((extBig >> 16n) & 0xffn));
    return { status: 10, ext_status: status };
  };

  export const encode = (env: OidbBase<OidbStrangerStatusReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbStrangerStatusReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbStrangerStatusResp> =>
    protobuf_decode<OidbBase<OidbStrangerStatusResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<StrangerStatus | null> =>
    invokeOidb(deps, GetStrangerStatus, params);
}
