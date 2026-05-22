// 0x9084_1 — fetch per-emoji reaction summary on a group message.
//
// Server returns the full summary unconditionally; the emoji_id /
// emoji_type / count fields in the request body are ignored by the
// summary handler but kept to mirror the working 0x9083_1 request shape
// (same `Pick` of fields the wire format prefers).
//
// "Used" entries carry (lastReactionTime, count, emojiType, emojiId).
// Catalog-tail entries (available reactions the server suggests but
// nobody has reacted with) carry only emojiType + emojiId — filtered
// out here so callers see only the meaningful subset.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x9084Req, Oidb0x9084Resp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace FetchReactionSummary {
  export const command = 0x9084;
  export const subCommand = 1;

  export interface Params {
    groupId: number;
    sequence: number;
  }

  export interface ReactionSummaryEntry {
    emojiId: string;
    emojiType: number;
    count: number;
    /** Unix epoch seconds of the most recent reaction. */
    lastReactionTime: number;
  }

  export type Deps = OidbSender;

  export const serialize = (p: Params): Oidb0x9084Req => ({
    groupId: BigInt(p.groupId),
    sequence: BigInt(p.sequence),
    emojiId: '',
    emojiType: 0,
    cookie: new Uint8Array(0),
    count: 0,
    field12: 1,
  });

  export const deserialize = (body: Oidb0x9084Resp): ReactionSummaryEntry[] => {
    const out: ReactionSummaryEntry[] = [];
    for (const e of body.entries ?? []) {
      const count = e.count ?? 0;
      if (count <= 0) continue; // skip catalog-tail entries
      out.push({
        emojiId: e.emojiId ?? '',
        emojiType: e.emojiType ?? 1,
        count,
        lastReactionTime: Number(e.lastReactionTime ?? 0n),
      });
    }
    return out;
  };

  export const encode = (env: OidbBase<Oidb0x9084Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x9084Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x9084Resp> =>
    protobuf_decode<OidbBase<Oidb0x9084Resp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<ReactionSummaryEntry[]> =>
    invokeOidb(deps, FetchReactionSummary, params);
}
