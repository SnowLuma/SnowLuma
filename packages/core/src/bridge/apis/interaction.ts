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
    // Wire-level investigation against macOS NTQQ confirmed:
    //   - cmd 0x9083_1 is a real, server-recognized OIDB endpoint
    //   - our request fields (groupId/sequence/emojiId/emojiType/count) are
    //     encoded correctly per the schema
    //   - BUT the server reply for 0x9083_1 is always exactly `18 01 20 01`
    //     (field 3 = 1, field 4 = 1) — a 4-byte minimal ack, no user list
    // That means 0x9083_1's semantics aren't "fetch emoji-like users". To
    // probe the real cmd/subcmd, allow an env override so deployment can
    // round-robin across candidates (0x9082_3, 0x9082_4, 0x9083_2, …)
    // without rebuilding. Format: `SNOWLUMA_EMOJI_FETCH_CMD=0x9082_3`.
    let cmdHex = 0x9083;
    let subCmd = 1;
    const envOverride = process.env.SNOWLUMA_EMOJI_FETCH_CMD;
    if (envOverride) {
      const m = /^0x([0-9a-fA-F]+)_(\d+)$/.exec(envOverride.trim());
      if (m) {
        cmdHex = parseInt(m[1], 16);
        subCmd = parseInt(m[2], 10);
      } else {
        log.warn(`SNOWLUMA_EMOJI_FETCH_CMD malformed: ${JSON.stringify(envOverride)} (expected 0xNNNN_N); falling back to 0x9083_1`);
      }
    }
    const wireName = `OidbSvcTrpcTcp.0x${cmdHex.toString(16)}_${subCmd}`;
    const env = makeOidbEnvelope<Oidb0x9083Req>(cmdHex, subCmd, req);
    const reqBytes = protobuf_encode<OidbBase<Oidb0x9083Req>>(env);
    const respBytes = await runOidb(bridge, wireName, reqBytes);
    const resp = protobuf_decode<OidbBase<Oidb0x9083Resp>>(respBytes).body;
    // userInfo is repeated on the wire — one entry per liker. The pre-fix
    // schema treated it as single, which made multi-user responses collapse
    // into one and (when paired with the swapped req fields) yield [].
    const users: Array<{ uin: number }> = (resp?.inner?.userInfo ?? [])
      .map(u => ({ uin: Number(u?.uin ?? 0) }))
      .filter(u => u.uin > 0);
    const respCookie = resp?.cookie ? Buffer.from(resp.cookie).toString('base64') : '';
    // Always dump req/resp hex (debug level) while we're probing the real
    // cmd. Once we land on a working (cmd, subcmd) tuple, this branch can
    // be tightened back to "only on empty users".
    log.debug(
      `getEmojiLikes ${users.length === 0 ? 'empty' : 'ok'} via ${wireName}: `
      + `group=${groupId} seq=${sequence} emojiId=${emojiId} `
      + `emojiType=${emojiType} count=${count} `
      + `cookieIn=${cookie ? 'yes' : 'no'} respCookieOut=${respCookie || '(empty)'} `
      + `users=${users.length}`,
    );
    log.debug(`  req  hex: ${toHexUpper(reqBytes)}`);
    log.debug(`  resp hex: ${toHexUpper(respBytes)}`);
    return { users, cookie: respCookie, isLast: !respCookie };
  }
}
