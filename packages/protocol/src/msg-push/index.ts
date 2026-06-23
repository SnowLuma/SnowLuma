import { hexPreview } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { Elem } from '@snowluma/proto-defs/element';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { bodyHasDecodableContent, isC2cControlPush } from './blank-filter';
import { buildContext, type PushMsgBody } from './context';
import { decodeEvent0x210 } from './decoders/event-0x210';
import { decodeEvent0x2DC } from './decoders/event-0x2dc';
import { decodeFriendMessage } from './decoders/friend-message';
import { decodeGroupAdmin } from './decoders/group-admin';
import {
  decodeGroupInvitation, decodeGroupInvite,
  decodeGroupJoinRequest,
} from './decoders/group-join-request';
import {
  decodeGroupMemberJoin, decodeGroupMemberLeave, decodeGroupSelfJoined,
} from './decoders/group-member-change';
import { decodeGroupMessage } from './decoders/group-message';
import { decodeTempMessage } from './decoders/temp-message';
import { PkgType } from './enums';
import { MsgPushRegistry } from './registry';
import { SysMsgDedup } from './sysmsg-dedup';

export { SysMsgDedup } from './sysmsg-dedup';

export { SSO_GET_GROUP_MSG_CMD, fetchGroupMessageRange } from './fetch-group-history';
export { SSO_GET_C2C_MSG_CMD, fetchC2cMessageRange } from './fetch-c2c-history';

export const MSG_PUSH_CMD = 'trpc.msg.olpush.OlPushService.MsgPush';

const registry = new MsgPushRegistry();
registry.register(PkgType.GroupMemberIncreaseNotice, decodeGroupMemberJoin);
registry.register(PkgType.GroupMemberDecreaseNotice, decodeGroupMemberLeave);
registry.register(PkgType.GroupSelfJoinedNotice, decodeGroupSelfJoined);
registry.register(PkgType.GroupAdminChangedNotice, decodeGroupAdmin);
registry.register(PkgType.GroupRequestJoinNotice, decodeGroupJoinRequest);
registry.register(PkgType.GroupRequestInvitationNotice, decodeGroupInvitation);
registry.register(PkgType.GroupInviteNotice, decodeGroupInvite);
registry.register(PkgType.Event0x210, decodeEvent0x210);
registry.register(PkgType.Event0x2DC, decodeEvent0x2DC);
registry.register(PkgType.GroupMessage, decodeGroupMessage);
registry.register(PkgType.TempMessage, decodeTempMessage);
registry.register([
  PkgType.PrivateMessage,
  PkgType.ForwardFakePrivateMessage,
  PkgType.PrivateRecordMessage,
  PkgType.PrivateFileMessage,
], decodeFriendMessage);

const log = createLogger('MsgPush');

// Kinds that carry decoded `elements`; an empty list surfaces to clients as the
// confusing "[空消息]".
const MESSAGE_KINDS = new Set<QQEventVariant['kind']>([
  'friend_message', 'group_message', 'temp_message',
]);

/**
 * Summarise a body that decoded to zero elements despite carrying content —
 * each element's field names, every `commonElem`'s serviceType/businessType +
 * payload hex, and any `msgContent` — so a missing decoder can be identified
 * from one log line rather than swallowed silently.
 */
function describeUndecodedBody(body: PushMsgBody | undefined): string {
  const elems = (body?.richText?.elems ?? []) as Elem[];
  const parts = elems.map((e) => {
    if (e.commonElem) {
      const ce = e.commonElem;
      const pb = ce.pbElem && ce.pbElem.length > 0 ? ` pbElem=${hexPreview(ce.pbElem, 256)}` : '';
      return `commonElem(svc=${ce.serviceType ?? 0},biz=${ce.businessType ?? 0})${pb}`;
    }
    const keys = Object.keys(e).filter((k) => (e as Record<string, unknown>)[k] != null);
    return keys.join('+') || '(empty)';
  });
  const extras: string[] = [];
  if (body?.richText?.ptt) extras.push('ptt');
  if (body?.richText?.notOnlineFile) extras.push('notOnlineFile');
  if (body?.msgContent && body.msgContent.length > 0) {
    extras.push(`msgContent=${hexPreview(body.msgContent, 256)}`);
  }
  return `elems=[${parts.join('; ')}]${extras.length ? ` ${extras.join(' ')}` : ''}`;
}

export function parseMsgPush(
  pkt: PacketInfo,
  identity: IdentityService,
  dedup?: SysMsgDedup,
): QQEventVariant[] {
  const ctx = buildContext(pkt, identity);
  if (!ctx) return [];
  const events = registry.decode(ctx);
  const out = events.filter((ev) => {
    if (!MESSAGE_KINDS.has(ev.kind)) return true;
    // C2C control/system signal (#102): QQ NT routes these via OnRecvSysMsg and
    // never shows them as a bubble. Drop by (msgType, c2cCmd) regardless of body
    // — the precise discriminator, the group-invite "[空消息]" phantom being one.
    if (isC2cControlPush(ctx.head)) {
      const elemCount = (ev as { elements?: unknown[] }).elements?.length ?? 0;
      if (elemCount > 0) {
        log.debug('dropped c2c control push that carried %d element(s) (kind=%s seq=%d from=%d msgType=%d cmd=%d)',
          elemCount, ev.kind, ctx.head.sequence, ctx.fromUin, ctx.head.msgType, ctx.head.c2cCmd);
      }
      return false;
    }
    if ((ev as { elements?: unknown[] }).elements?.length !== 0) return true;
    // Empty-element message that's NOT a known control cmd. Drop it when the body
    // is genuinely empty (a content-less push we don't yet classify by c2cCmd).
    // If instead the body *had* content we just couldn't decode, keep the
    // (still-empty) event but warn so the missing decoder gets noticed rather
    // than silently swallowed.
    if (bodyHasDecodableContent(ctx.body)) {
      log.warn('message had content but decoded to 0 elements — missing decoder? (kind=%s seq=%d from=%d msgType=%d/%d): %s',
        ev.kind, ctx.head.sequence, ctx.fromUin, ctx.head.msgType, ctx.head.subType,
        describeUndecodedBody(ctx.body));
      return true;
    }
    return false;
  });

  // #137: mirror QQ NT `sys_msg_mgr.cc::ProcessRecvSysMsg` global-key dedup.
  // The server pushes some system notices twice (e.g. inviting an official
  // robot → two `group_member_increase`); the kernel drops the duplicate by
  // (peer, seq, random) before any listener sees it, but we read the raw
  // OlPush, so we replicate the drop. Scoped to system pushes only — chat
  // messages have their own NT dedup path and the forward re-parse re-runs
  // this without a tracker. A push that decodes to a message kind, or to
  // nothing, is never deduped here.
  if (dedup && out.length > 0 && out.every((ev) => !MESSAGE_KINDS.has(ev.kind))) {
    if (dedup.seenDuplicate(ctx.head, ctx.fromUin)) {
      log.debug('dropped duplicate system push (kinds=%s seq=%d from=%d msgType=%d msgId=%d)',
        out.map((ev) => ev.kind).join(','), ctx.head.sequence, ctx.fromUin, ctx.head.msgType, ctx.head.msgId);
      return [];
    }
  }
  return out;
}
