import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbSetFriendCategoryRequest } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

/**
 * Move one friend into a category.
 *
 * The desktop client treats 2001002 as an idempotent success result.
 */
export namespace SetFriendCategory {
  export const command = 0x1255;
  export const subCommand = 0;
  export const uinForm = true;
  export const alreadyAppliedCode = 2_001_002;
  export const acceptedEnvelopeCodes = [alreadyAppliedCode] as const;

  export interface Params {
    uid: string;
    categoryId: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, params: Params): OidbSetFriendCategoryRequest => ({
    uid: params.uid,
    categoryId: params.categoryId,
  });

  export const deserialize = (): void => undefined;

  export const encode = (env: OidbBase<OidbSetFriendCategoryRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbSetFriendCategoryRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbSetFriendCategoryRequest> =>
    protobuf_decode<OidbBase<OidbSetFriendCategoryRequest>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SetFriendCategory, params);
}
