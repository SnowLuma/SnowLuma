// InteractionApi — interactive engagement primitives (poke / like /
// reaction / essence / emoji-like-list). Inlined from
// `actions/interaction.ts` + the lone-survivor `setGroupEssence` from
// `actions/group-message.ts` (both deleted alongside actions/* in
// commit 13). The recall+markRead halves of `group-message.ts` were
// already absorbed into `MessageApi` back in commit 1.

import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbEssence,
  OidbLike,
  OidbPoke,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';
// Vertical-slice migration: reaction-family OIDB calls now live as
// self-contained namespaces under @snowluma/bridge/oidb-services. The
// facade methods on this class are thin forwarders (1-line bodies) to
// preserve `bridge.apis.interaction.X()` ergonomics for callers that
// haven't migrated yet. The other (non-reaction) cmds still inline the
// envelope+encode+runOidb dance — they'll move in follow-up PRs.
import { SetReaction } from '@snowluma/bridge/oidb-services/reaction/set-reaction';
import { FetchReactionSummary } from '@snowluma/bridge/oidb-services/reaction/fetch-reaction-summary';
import { GetEmojiLikes } from '@snowluma/bridge/oidb-services/reaction/get-emoji-likes';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

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

  setReaction(groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> {
    return SetReaction.invoke(this.ctx, { groupId, sequence, code, isSet });
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
    // Legacy stub: see `GetEmojiLikes` namespace comment for why this
    // SSO path can never surface the user list. Real data lives in
    // ReactionStore on the OneBot side.
    try {
      return await GetEmojiLikes.invoke(this.ctx, { groupId, sequence, emojiId, emojiType, count, cookie });
    } catch {
      return { users: [], cookie: '', isLast: true };
    }
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
  fetchReactionSummary(
    groupId: number,
    sequence: number,
  ): Promise<Array<{ emojiId: string; emojiType: number; count: number; lastReactionTime: number }>> {
    return FetchReactionSummary.invoke(this.ctx, { groupId, sequence });
  }
}
