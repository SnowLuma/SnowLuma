import type { pb, pb_optional, pb_repeated, uint_32 } from '@snowluma/proton';

/** One tag shown under a group-profile category. */
export interface OidbGroupCategoryTag {
  id?: pb<1, uint_32>;
  name?: pb<2, string>;
  type?: pb<3, uint_32>;
}

/** List the tags of one category. Category 0 is a real value and must be sent. */
export interface OidbGetGroupCategoryTags {
  groupClass?: pb_optional<1, uint_32>;
}

export interface OidbGetGroupCategoryTagsResp {
  tags?: pb_repeated<1, OidbGroupCategoryTag>;
}

/** Add or remove one tag name in a category. */
export interface OidbChangeGroupCategoryTag {
  groupClass?: pb_optional<1, uint_32>;
  name?: pb<2, string>;
}
