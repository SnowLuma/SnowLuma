import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbBaseMeta } from '@snowluma/proto-defs/oidb';
import type { OidbSetFriendCategoryRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { makeOidbEnvelope } from '../../bridge-oidb';
import { OidbError, type OidbSender } from '../../oidb-service';

/**
 * Move one friend into a category.
 *
 * The desktop client treats 2001002 as an idempotent success result, so this
 * call intentionally validates the response itself instead of using the
 * generic OIDB helper that rejects every non-zero application code.
 */
export namespace SetFriendCategory {
  export const command = 0x1255;
  export const subCommand = 0;
  export const uinForm = true;
  export const alreadyAppliedCode = 2_001_002;

  export interface Params {
    uid: string;
    categoryId: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, params: Params): OidbSetFriendCategoryRequest => ({
    uid: params.uid,
    categoryId: params.categoryId,
  });

  function accepted(code: number | null | undefined): boolean {
    return code == null || code === 0 || code === alreadyAppliedCode;
  }

  export async function invoke(deps: Deps, params: Params): Promise<void> {
    const body = serialize(deps, params);
    const bytes = protobuf_encode<OidbBase<OidbSetFriendCategoryRequest>>(
      makeOidbEnvelope(command, subCommand, body, uinForm),
    );
    const result = await deps.sendRawPacket('OidbSvcTrpcTcp.0x1255_0', bytes);

    if (!result.gotResponse) {
      throw new Error(result.errorMessage || 'no response');
    }
    if (!result.success && result.errorCode !== alreadyAppliedCode) {
      if (result.errorCode) {
        throw new OidbError(result.errorCode, result.errorMessage, command, subCommand);
      }
      throw new Error(result.errorMessage || 'packet send failed');
    }
    if (!accepted(result.errorCode)) {
      throw new OidbError(result.errorCode, result.errorMessage, command, subCommand);
    }

    const response = result.responseData ?? new Uint8Array(0);
    if (response.length === 0) return;
    const meta = protobuf_decode<OidbBaseMeta>(response);
    if (!accepted(meta.errorCode)) {
      throw new OidbError(meta.errorCode!, meta.errorMsg ?? '', command, subCommand);
    }
  }
}
