// MsgPush entry point — assembles the PkgType registry and exposes
// `parseMsgPush(pkt, identity)` as the single CmdParser registered against
// `MSG_PUSH_CMD` on the IncomingPacketPipeline.

import type { PacketInfo } from '../../protocol/types';
import type { IdentityService } from '../identity-service';
import type { QQEventVariant } from '../events';
import { buildContext } from './context';
import { MsgPushRegistry } from './registry';
import { PkgType } from './enums';
import {
  decodeGroupMemberJoin, decodeGroupMemberLeave, decodeGroupSelfJoined,
} from './decoders/group-member-change';
import { decodeGroupAdmin } from './decoders/group-admin';
import {
  decodeGroupJoinRequest, decodeGroupInvitation, decodeGroupInvite,
} from './decoders/group-join-request';
import { decodeEvent0x210 } from './decoders/event-0x210';
import { decodeEvent0x2DC } from './decoders/event-0x2dc';
import { decodeGroupMessage } from './decoders/group-message';
import { decodeTempMessage } from './decoders/temp-message';
import { decodeFriendMessage } from './decoders/friend-message';

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

export function parseMsgPush(pkt: PacketInfo, identity: IdentityService): QQEventVariant[] {
  const ctx = buildContext(pkt, identity);
  if (!ctx) return [];
  return registry.decode(ctx);
}
