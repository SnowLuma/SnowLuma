// 0xF16_1 — set the bot's local-only label/remark for a group (only
// the bot sees this — the group's actual name is untouched).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { createLogger } from '@snowluma/common/logger';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { Oidb0xf16Req } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

const log = createLogger('Bridge.GroupAdmin');

export namespace SetGroupRemark {
  export const command = 0xF16;
  export const subCommand = 1;

  export interface Params { groupId: number; remark: string; }
  export type Deps = OidbSender & Pick<BridgeContext, 'identity'>;

  export const serialize = (_ctx: Deps, p: Params): Oidb0xf16Req => ({
    inner: { groupId: BigInt(p.groupId), remark: p.remark },
    field12: 0,
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};
  export const encode = (env: OidbBase<Oidb0xf16Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0xf16Req>>(env);
  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    await invokeOidb(deps, SetGroupRemark, params);

    // QQ has already accepted the mutation. Keep the local roster coherent,
    // but never turn a local-cache problem into a false remote failure that
    // encourages callers to repeat the mutation.
    try {
      const updated = deps.identity.updateGroupRemark(params.groupId, params.remark);
      if (!updated) {
        log.warn(
          'local group roster did not contain server-confirmed remark target: uin=%s group=%d',
          deps.identity.uin,
          params.groupId,
        );
      }
    } catch (error: unknown) {
      log.error(
        'local identity synchronization failed after confirmed group remark update: uin=%s group=%d: %s',
        deps.identity.uin,
        params.groupId,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}
