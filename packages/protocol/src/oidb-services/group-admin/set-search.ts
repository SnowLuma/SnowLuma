// 0x89A_0 — set a group's "被搜索方式" (searchability). Same cmd+subcmd shape as
// MuteAll / SetAddOption / SetName; the `settings` submessage carries the two
// search flags. Empty settings is a no-op (why the earlier version silently
// did nothing) — a real change must emit at least one flag. Command + tags
// (noFingerOpen=35, noCodeFingerOpen=36) RE'd empirically on a live group by
// sweeping the modify sub-message and reading the effect back through the
// 0x88D_0 GET (see Oidb0x89a_0SearchSettings for the full derivation).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0x89a_0Search, Oidb0x89a_0SearchSettings } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace SetSearch {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params {
    groupId: number;
    /** 群指纹（关键词）搜索开关。undefined → 不改（不下发该字段）。 */
    noFingerOpen?: number;
    /** 群号搜索开关。undefined → 不改（不下发该字段）。 */
    noCodeFingerOpen?: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0x89a_0Search => {
    const settings: Oidb0x89a_0SearchSettings = {};
    if (p.noFingerOpen !== undefined) settings.noFingerOpen = p.noFingerOpen;
    if (p.noCodeFingerOpen !== undefined) settings.noCodeFingerOpen = p.noCodeFingerOpen;
    return { groupUin: BigInt(p.groupId), settings, field12: 0 };
  };

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<Oidb0x89a_0Search>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x89a_0Search>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetSearch, params);
}
