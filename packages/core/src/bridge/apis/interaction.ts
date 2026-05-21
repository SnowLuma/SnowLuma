// InteractionApi — interactive engagement primitives (poke / like /
// reaction / essence / emoji-like-list). Inlined from
// `actions/interaction.ts` + the lone-survivor `setGroupEssence` from
// `actions/group-message.ts` (both deleted alongside actions/* in
// commit 13). The recall+markRead halves of `group-message.ts` were
// already absorbed into `MessageApi` back in commit 1.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0x9083Req,
  Oidb0x9083Resp,
  OidbEssence,
  OidbGroupReaction,
  OidbLike,
  OidbPoke,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';

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
      sequence,
      emojiType,
      emojiId,
      cookie: cookie ? Buffer.from(cookie, 'base64') : new Uint8Array(0),
      field7: 0,
      count,
      field12: 1,
    };
    const env = makeOidbEnvelope<Oidb0x9083Req>(0x9083, 1, req);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x9083_1', protobuf_encode<OidbBase<Oidb0x9083Req>>(env));
    const resp = protobuf_decode<OidbBase<Oidb0x9083Resp>>(respBytes).body;
    const uin = resp?.inner?.userInfo?.uin;
    const users = uin ? [{ uin: Number(uin) }] : [];
    const respCookie = resp?.cookie ? Buffer.from(resp.cookie).toString('base64') : '';
    return { users, cookie: respCookie, isLast: !respCookie };
  }
}
