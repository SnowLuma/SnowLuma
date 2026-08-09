// 0x902e_1 opType=2 — supplement the Faceroam custom-face id list with the
// server-side descriptions. QQ first fetches ids through Faceroam.OpReq, then
// sends every {emojiId, md5} here. The response returns repeated entries in f4.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  CustomFaceModifyResp,
  CustomFaceMoveBody,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { CLIENT_VERSION } from './shared';

export namespace FetchCustomFaceDetail {
  export const command = 0x902e;
  export const subCommand = 1;
  export const uinForm = true;

  export interface EmojiItem {
    emojiId: string;
    md5: string;
  }

  export interface Params {
    emojis: EmojiItem[];
  }

  export interface Detail {
    emojiId: string;
    desc: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): CustomFaceMoveBody => ({
    field1: 1,
    osVersion: CLIENT_VERSION,
    opType: 2,
    emojis: p.emojis.map((emoji) => ({
      emojiId: emoji.emojiId,
      md5: emoji.md5,
    })),
  });

  export const deserialize = (_ctx: Deps, body: CustomFaceModifyResp): Detail[] => {
    if (body.retCode && body.retCode !== 0) {
      throw new Error(`fetch custom face detail error: ${body.errMsg || body.retCode}`);
    }

    const seen = new Set<string>();
    return (body.entries ?? []).map((entry, index) => {
      const emojiId = entry.emoji?.emojiId;
      if (!emojiId) {
        throw new Error(`fetch custom face detail response entry ${index} has no emoji id`);
      }
      if (seen.has(emojiId)) {
        throw new Error(`fetch custom face detail response has duplicate emoji id: ${emojiId}`);
      }
      seen.add(emojiId);
      return {
        emojiId,
        // Current builds use tag 3. Older builds use tag 2 when tag 3 is empty.
        desc: entry.desc || entry.legacyDesc || '',
      };
    });
  };

  export const encode = (env: OidbBase<CustomFaceMoveBody>): Uint8Array =>
    protobuf_encode<OidbBase<CustomFaceMoveBody>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<CustomFaceModifyResp> =>
    protobuf_decode<OidbBase<CustomFaceModifyResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Detail[]> =>
    invokeOidb(deps, FetchCustomFaceDetail, params);
}
