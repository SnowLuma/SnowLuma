// InteractionApi — interactive engagement primitives (poke / like /
// reaction / essence / emoji-like-list). Inlined from
// `actions/interaction.ts` + the lone-survivor `setGroupEssence` from
// `actions/group-message.ts` (both deleted alongside actions/* in
// commit 13). The recall+markRead halves of `group-message.ts` were
// already absorbed into `MessageApi` back in commit 1.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { toHexUpper } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x9083Req,
  Oidb0x9083Resp,
  Oidb0x9084Req,
  Oidb0x9084Resp,
  OidbEssence,
  OidbGroupReaction,
  OidbLike,
  OidbPoke,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

const log = createLogger('Interaction');

export class InteractionApi {
  constructor(private readonly ctx: BridgeContext) {}

  async sendPoke(isGroup: boolean, peerUin: number, targetUin?: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbPoke>(0xED3, 1, {
      uin: targetUin ?? peerUin,
      groupUin: isGroup ? peerUin : 0,
      friendUin: isGroup ? 0 : peerUin,
      ext: 0,
    });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0xed3_1', protobuf_encode<OidbBase<OidbPoke>>(env));
  }

  async sendLike(userId: number, count: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const env = makeOidbEnvelope<OidbLike>(0x7E5, 104, { targetUin: userId, count });
    await runOidb(bridge, 'OidbSvcTrpcTcp.0x7e5_104', protobuf_encode<OidbBase<OidbLike>>(env));
  }

  async setReaction(groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> {
    const bridge = asBridge(this.ctx);
    const subCmd = isSet ? 1 : 2;
    const cmd = isSet ? 'OidbSvcTrpcTcp.0x9082_1' : 'OidbSvcTrpcTcp.0x9082_2';
    // Same heuristic Lagrange.Core V2 uses (`GroupAddReactionEvent.IsEmoji`):
    // QQ face ids are 1–3 digits ("76") → type=1, unicode codepoints are
    // longer ("128516") → type=2. Server reads the type at field 5; sending
    // it at the wrong field number triggers
    // "invalid ReqBody.EmojiType: value must be greater than 0".
    const type = code.length > 3 ? 2 : 1;
    const env = makeOidbEnvelope<OidbGroupReaction>(0x9082, subCmd, {
      groupUin: groupId, sequence, code, type, field6: false, field7: false,
    });
    await runOidb(bridge, cmd, protobuf_encode<OidbBase<OidbGroupReaction>>(env));
  }

  async setEssence(groupId: number, sequence: number, random: number, enable: boolean): Promise<void> {
    const bridge = asBridge(this.ctx);
    const subCmd = enable ? 1 : 2;
    const cmd = enable ? 'OidbSvcTrpcTcp.0xeac_1' : 'OidbSvcTrpcTcp.0xeac_2';
    const env = makeOidbEnvelope<OidbEssence>(0xEAC, subCmd, { groupUin: groupId, sequence, random });
    await runOidb(bridge, cmd, protobuf_encode<OidbBase<OidbEssence>>(env));
  }

  async getEmojiLikes(
    groupId: number,
    sequence: number,
    emojiId: string,
    emojiType = 1,
    count = 10,
    cookie = '',
  ): Promise<{ users: Array<{ uin: number }>; cookie: string; isLast: boolean }> {
    const bridge = asBridge(this.ctx);
    const req: any = {
      groupId: BigInt(groupId),
      // sequence is uint_64 on the wire (matches LagrangeV2's
      // SetGroupReactionRequest.Sequence:ulong). Caller still passes
      // a JS number — bigint conversion lives here.
      sequence: BigInt(sequence),
      emojiType,
      emojiId,
      cookie: cookie ? Buffer.from(cookie, 'base64') : new Uint8Array(0),
      field7: 0,
      count,
      field12: 1,
    };
    // Two rounds of wire-level probing against macOS NTQQ confirmed:
    //   - 0x9083_1 returns a 4-byte ack `18 01 20 01` (no user list)
    //   - 0x9084_1 returns a per-emoji reaction *summary* (emoji_id +
    //     count + last-reaction timestamp), no user IDs — see
    //     `fetchReactionSummary` below
    //   - 0x9082_3..5, 0x9083_0/2/3, 0x9084_2..5, 0x9085_1/2, 0x9087_1
    //     all reject with "no privilege": the cmds exist but aren't in
    //     the NTQQ client's capability bitmap, so the server blocks
    //     anything not registered at login. NTQQ's own
    //     `getMsgEmojiLikesList` uses a wrapper-internal cache, not SSO.
    // So this OIDB path can never surface the user list. The real
    // implementation lives in `ReactionStore` on the OneBot side, fed
    // from `GroupMsgEmojiLikeEvent` push. This method is retained so
    // legacy callers don't crash — they get an empty users array.
    const env = makeOidbEnvelope<Oidb0x9083Req>(0x9083, 1, req);
    const reqBytes = protobuf_encode<OidbBase<Oidb0x9083Req>>(env);
    let respBytes: Uint8Array;
    try {
      respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x9083_1', reqBytes);
    } catch (e) {
      log.debug(`getEmojiLikes 0x9083_1 threw: ${e instanceof Error ? e.message : String(e)}`);
      return { users: [], cookie: '', isLast: true };
    }
    const resp = protobuf_decode<OidbBase<Oidb0x9083Resp>>(respBytes).body;
    const users: Array<{ uin: number }> = (resp?.inner?.userInfo ?? [])
      .map(u => ({ uin: Number(u?.uin ?? 0) }))
      .filter(u => u.uin > 0);
    const respCookie = resp?.cookie ? Buffer.from(resp.cookie).toString('base64') : '';
    if (users.length === 0) {
      log.debug(
        `getEmojiLikes empty (expected — use ReactionStore instead): `
        + `group=${groupId} seq=${sequence} emojiId=${emojiId} `
        + `respLen=${respBytes.length}`,
      );
    }
    return { users, cookie: respCookie, isLast: !respCookie };
  }

  /**
   * Fetch the per-emoji *reaction summary* on a group message via
   * OIDB 0x9084_1 (the cmd that's actually in NTQQ's capability
   * whitelist and returns real data). Returns one entry per emoji
   * that has been reacted with on the message: emoji_id + total
   * reactor count + timestamp of the last reaction.
   *
   * This is the "server-truth" counterpart to the local ReactionStore
   * cache: ReactionStore tracks *who* reacted (from push events), and
   * `fetchReactionSummary` tells us *how many* the server thinks there
   * are. Cross-checking the two lets callers detect cache gaps (push
   * events lost before the bot booted, etc).
   *
   * Catalog entries (available emojis with no count/timestamp) are
   * filtered out — callers want the "used" subset.
   */
  async fetchReactionSummary(
    groupId: number,
    sequence: number,
  ): Promise<Array<{ emojiId: string; emojiType: number; count: number; lastReactionTime: number }>> {
    const bridge = asBridge(this.ctx);
    const req: any = {
      groupId: BigInt(groupId),
      sequence: BigInt(sequence),
      // Match the request shape the 0x9083_1 path sends so the server
      // routes us identically. `count`/`emojiId`/`emojiType` are
      // ignored by the summary handler but harmless.
      emojiId: '',
      emojiType: 0,
      cookie: new Uint8Array(0),
      count: 0,
      field12: 1,
    };
    const env = makeOidbEnvelope<Oidb0x9084Req>(0x9084, 1, req);
    const reqBytes = protobuf_encode<OidbBase<Oidb0x9084Req>>(env);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x9084_1', reqBytes);
    const resp = protobuf_decode<OidbBase<Oidb0x9084Resp>>(respBytes).body;
    const out: Array<{ emojiId: string; emojiType: number; count: number; lastReactionTime: number }> = [];
    for (const e of resp?.entries ?? []) {
      const count = e.count ?? 0;
      // Filter the catalog tail. "Used" entries always have count > 0
      // and a lastReactionTime; catalog entries have neither.
      if (count <= 0) continue;
      out.push({
        emojiId: e.emojiId ?? '',
        emojiType: e.emojiType ?? 1,
        count,
        lastReactionTime: Number(e.lastReactionTime ?? 0n),
      });
    }
    return out;
  }
}
