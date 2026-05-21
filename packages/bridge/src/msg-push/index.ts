import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { buildContext } from './context';
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
