// InteractionApi — facade over interactive-engagement OIDB cmds
// (poke / like / reaction / essence / emoji-like-list). Every method
// is a one-line forwarder to a self-contained namespace under
// @snowluma/protocol/oidb-services. The facade exists purely to keep
// the `bridge.apis.interaction.X(...)` ergonomic call style; all wire
// work (envelope build / encode / send / decode) lives in the
// namespace files.

import type { BridgeContext } from '../bridge-context';
import { SendPoke } from '@snowluma/protocol/oidb-services/interaction/send-poke';
import { SendLike } from '@snowluma/protocol/oidb-services/interaction/send-like';
import { SetEssence } from '@snowluma/protocol/oidb-services/interaction/set-essence';
import { SetReaction } from '@snowluma/protocol/oidb-services/reaction/set-reaction';
import { FetchReactionSummary } from '@snowluma/protocol/oidb-services/reaction/fetch-reaction-summary';
import { GetEmojiLikes } from '@snowluma/protocol/oidb-services/reaction/get-emoji-likes';

export class InteractionApi {
  constructor(private readonly ctx: BridgeContext) {}

  sendPoke(isGroup: boolean, peerUin: number, targetUin?: number): Promise<void> {
    return SendPoke.invoke(this.ctx, { isGroup, peerUin, targetUin });
  }

  sendLike(userId: number, count: number): Promise<void> {
    return SendLike.invoke(this.ctx, { userId, count });
  }

  setReaction(groupId: number, sequence: number, code: string, isSet: boolean): Promise<void> {
    return SetReaction.invoke(this.ctx, { groupId, sequence, code, isSet });
  }

  setEssence(groupId: number, sequence: number, random: number, enable: boolean): Promise<void> {
    return SetEssence.invoke(this.ctx, { groupId, sequence, random, enable });
  }

  /**
   * Legacy stub: see `GetEmojiLikes` namespace comment for why this
   * SSO path can never surface the user list. Real data lives in
   * ReactionStore on the OneBot side.
   */
  async getEmojiLikes(
    groupId: number,
    sequence: number,
    emojiId: string,
    emojiType = 1,
    count = 10,
    cookie = '',
  ): Promise<{ users: Array<{ uin: number }>; cookie: string; isLast: boolean }> {
    try {
      return await GetEmojiLikes.invoke(this.ctx, { groupId, sequence, emojiId, emojiType, count, cookie });
    } catch {
      return { users: [], cookie: '', isLast: true };
    }
  }

  /**
   * Fetch the per-emoji reaction summary on a group message via
   * 0x9084_1 — emoji_id + reactor count + last-reaction timestamp.
   * Cross-checked against the local ReactionStore cache for callers
   * that need to detect cache gaps.
   */
  fetchReactionSummary(
    groupId: number,
    sequence: number,
  ): Promise<Array<{ emojiId: string; emojiType: number; count: number; lastReactionTime: number }>> {
    return FetchReactionSummary.invoke(this.ctx, { groupId, sequence });
  }
}
