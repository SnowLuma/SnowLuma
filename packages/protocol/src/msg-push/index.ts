import { hexPreview } from '@snowluma/common/hex';
import { createLogger } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { Elem } from '@snowluma/proto-defs/element';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
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
 * Diagnostic for issue #102 (group invite → "[空消息]"). When a message decodes
 * to zero elements, dump what its body actually carried — each element's field
 * names, every `commonElem`'s serviceType/businessType + payload hex, and any
 * `msgContent` — so we can tell a genuinely content-less control push from an
 * element type we simply don't decode yet (and then decode it, rather than
 * blindly dropping the message). TODO(#102): remove once the culprit element is
 * identified and handled.
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

export function parseMsgPush(pkt: PacketInfo, identity: IdentityService): QQEventVariant[] {
  const ctx = buildContext(pkt, identity);
  if (!ctx) return [];
  const events = registry.decode(ctx);
  // #102 diagnostic — surface what an empty-decoded message actually contained.
  for (const ev of events) {
    if (MESSAGE_KINDS.has(ev.kind) && (ev as { elements?: unknown[] }).elements?.length === 0) {
      log.warn('[#102] empty message (kind=%s seq=%d from=%d msgType=%d/%d): %s',
        ev.kind, ctx.head.sequence, ctx.fromUin, ctx.head.msgType, ctx.head.subType,
        describeUndecodedBody(ctx.body));
    }
  }
  return events;
}
