// 0x912E_0 — set the remark (备注) shown for a friend in the bot's
// own roster. Current QQ routes ordinary friend remarks through
// StrangerRemarkSetWorker with scene=0.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { createLogger } from '@snowluma/common/logger';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbSetFriendRemark,
  OidbSetFriendRemarkResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, OidbError, type OidbSender } from '../../oidb-service';
import type { BridgeContext } from '../../bridge-context';

const log = createLogger('Bridge.Friend');

export namespace SetFriendRemark {
  export const command = 0x912E;
  export const subCommand = 0;

  export interface Params {
    userId: number;
    remark: string;
  }

  interface WireParams {
    targetUid: string;
    remark: string;
  }

  export interface Result {
    targetUid: string;
    targetUin: number;
    remark: string;
  }

  export type Deps = OidbSender & Pick<BridgeContext, 'identity' | 'resolveUserUid'>;

  export const serialize = (_ctx: Deps, p: WireParams): OidbSetFriendRemark => ({
    change: {
      target: { targetUid: p.targetUid },
      remark: p.remark,
    },
    scene: 0,
  });

  export const deserialize = (_ctx: Deps, response: OidbSetFriendRemarkResponse): Result => {
    if (response.error) {
      const code = response.error.code ?? 0;
      const message = response.error.message ?? '';
      if (code !== 0) throw new OidbError(code, message, command, subCommand);
      throw new Error(`invalid friend remark response: error result has no failure code${message ? ` (${message})` : ''}`);
    }

    const result = response.result;
    if (!result) throw new Error('invalid friend remark response: missing result');
    const targetUid = result?.target?.targetUid ?? '';
    const rawTargetUin = result?.target?.targetUin ?? '';
    const targetUin = rawTargetUin ? Number(rawTargetUin) : 0;
    if (rawTargetUin && (!Number.isSafeInteger(targetUin) || targetUin <= 0)) {
      throw new Error(`invalid friend remark response: invalid target UIN ${rawTargetUin}`);
    }
    return { targetUid, targetUin, remark: result?.remark ?? '' };
  };

  export const encode = (env: OidbBase<OidbSetFriendRemark>): Uint8Array =>
    protobuf_encode<OidbBase<OidbSetFriendRemark>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSetFriendRemarkResponse> =>
    protobuf_decode<OidbBase<OidbSetFriendRemarkResponse>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<void> => {
    const targetUid = await deps.resolveUserUid(params.userId);
    const result = await invokeOidb(deps, SetFriendRemark, {
      targetUid,
      remark: params.remark,
    });
    if (result.targetUid !== targetUid) {
      throw new Error(`friend remark response target mismatch: expected UID ${targetUid}, got ${result.targetUid || '(missing)'}`);
    }
    if (result.targetUin > 0 && result.targetUin !== params.userId) {
      throw new Error(`friend remark response target mismatch: expected UIN ${params.userId}, got ${result.targetUin}`);
    }
    if (result.remark !== params.remark) {
      throw new Error('friend remark response value does not match the requested remark');
    }
    // The server-side mutation has already completed. A local cache failure
    // must remain observable, but reporting the Action as failed here would
    // encourage callers to repeat an operation that QQ already accepted.
    try {
      deps.identity.updateFriendRemark(
        result.targetUid,
        result.targetUin || params.userId,
        result.remark,
      );
    } catch (error: unknown) {
      log.error(
        'local identity synchronization failed after confirmed friend remark update: uid=%s uin=%d: %s',
        result.targetUid,
        result.targetUin || params.userId,
        error instanceof Error ? error.message : String(error),
      );
    }
  };
}
