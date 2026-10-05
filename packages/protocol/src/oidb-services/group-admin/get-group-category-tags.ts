import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGetGroupCategoryTags,
  OidbGetGroupCategoryTagsResp,
  OidbGroupCategoryTag,
} from '@snowluma/proto-defs/oidb-actions/group-category-tag';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export interface GroupCategoryTag {
  id: number;
  name: string;
  type: number;
}

export namespace GetGroupCategoryTags {
  export const command = 0x967C;
  export const subCommand = 0;

  export interface Params {
    groupClass: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGetGroupCategoryTags => {
    assertGroupClass(p.groupClass);
    return { groupClass: p.groupClass };
  };

  export const deserialize = (
    _ctx: Deps,
    body: OidbGetGroupCategoryTagsResp,
  ): { tags: GroupCategoryTag[] } => ({
    tags: (body.tags ?? []).map(toTag),
  });

  export const encode = (env: OidbBase<OidbGetGroupCategoryTags>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGetGroupCategoryTags>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGetGroupCategoryTagsResp> =>
    protobuf_decode<OidbBase<OidbGetGroupCategoryTagsResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<{ tags: GroupCategoryTag[] }> =>
    invokeOidb(deps, GetGroupCategoryTags, params);
}

function assertGroupClass(groupClass: number): void {
  if (!Number.isInteger(groupClass) || groupClass < 0 || groupClass > 0xFFFFFFFF) {
    throw new Error(`group class ${groupClass} is out of range`);
  }
}

function toTag(tag: OidbGroupCategoryTag): GroupCategoryTag {
  return {
    id: tag.id ?? 0,
    name: tag.name ?? '',
    type: tag.type ?? 0,
  };
}
