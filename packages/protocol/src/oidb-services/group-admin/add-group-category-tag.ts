import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbChangeGroupCategoryTag } from '@snowluma/proto-defs/oidb-actions/group-category-tag';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace AddGroupCategoryTag {
  export const command = 0x967D;
  export const subCommand = 0;

  export interface Params {
    groupClass: number;
    name: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbChangeGroupCategoryTag => {
    assertTagChange(p.groupClass, p.name);
    return { groupClass: p.groupClass, name: p.name };
  };

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbChangeGroupCategoryTag>): Uint8Array =>
    protobuf_encode<OidbBase<OidbChangeGroupCategoryTag>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, AddGroupCategoryTag, params);
}

function assertTagChange(groupClass: number, name: string): void {
  if (!Number.isInteger(groupClass) || groupClass < 0 || groupClass > 0xFFFFFFFF) {
    throw new Error(`group class ${groupClass} is out of range`);
  }
  if (name.length === 0) throw new Error('tag name must not be empty');
}
