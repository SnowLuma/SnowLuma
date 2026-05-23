// 0x89A_0 — toggle group全员禁言. `state` is the duration multiplier
// (0xFFFFFFFF for permanent mute, 0 for unmute). Multiple OIDB cmds
// share the (0x89A, 0) tuple — see also SetAddOption / SetSearch /
// SetName — disambiguated by the body proto shape.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbMuteAll } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace MuteAll {
  export const command = 0x89A;
  export const subCommand = 0;

  export interface Params { groupId: number; enable: boolean; }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbMuteAll => ({
    groupUin: p.groupId,
    muteState: { state: p.enable ? 0xFFFFFFFF : 0 },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbMuteAll>): Uint8Array =>
    protobuf_encode<OidbBase<OidbMuteAll>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, MuteAll, params);
}
