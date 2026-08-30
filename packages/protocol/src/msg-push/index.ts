import { createLogger } from '@snowluma/common/logger';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { QQEventVariant } from '../events';
import type { IdentityService } from '../identity-service';
import { classifyMessageSurvival, warnUndecodedMessage } from './blank-filter';
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
import {
  deriveSysMsgDedupIdentity,
  SysMsgDedup,
} from './sysmsg-dedup';

export {
  deriveSysMsgDedupIdentity,
  SysMsgDedup,
} from './sysmsg-dedup';
export type { SysMsgDedupIdentity } from './sysmsg-dedup';

export { SSO_GET_GROUP_MSG_CMD, fetchGroupMessageRange } from './fetch-group-history';
export {
  SSO_GET_C2C_MSG_CMD,
  SSO_GET_ROAM_MSG_CMD,
  fetchC2cMessageRange,
  fetchC2cRoamMessagePage,
  type C2cRoamPage,
} from './fetch-c2c-history';

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

function messageElements(ev: QQEventVariant): readonly unknown[] | undefined {
  if (ev.kind === 'friend_message' || ev.kind === 'group_message' || ev.kind === 'temp_message') {
    return ev.elements;
  }
  return undefined;
}

function warnMissingC2cSequence(ev: QQEventVariant, fromUin: number): void {
  if (
    (ev.kind === 'friend_message' || ev.kind === 'temp_message')
    && ev.sequenceAuthoritative === false
  ) {
    log.warn(
      'c2c message omitted NT sequence; keeping non-authoritative client sequence (kind=%s from=%d clientSeq=%d time=%d)',
      ev.kind,
      fromUin,
      ev.clientSeq ?? ev.msgSeq,
      ev.time,
    );
  }
}

export function parseMsgPush(
  pkt: PacketInfo,
  identity: IdentityService,
  dedup?: SysMsgDedup,
): QQEventVariant[] {
  return parseMsgPushInternal(
    pkt,
    identity,
    dedup,
    false,
  );
}

export function parseMsgPushOrThrow(
  pkt: PacketInfo,
  identity: IdentityService,
  dedup?: SysMsgDedup,
): QQEventVariant[] {
  return parseMsgPushInternal(
    pkt,
    identity,
    dedup,
    true,
  );
}

function parseMsgPushInternal(
  pkt: PacketInfo,
  identity: IdentityService,
  dedup: SysMsgDedup | undefined,
  throwDecoderErrors: boolean,
): QQEventVariant[] {
  const ctx = buildContext(pkt, identity);
  if (!ctx) {
    log.trace(() => [
      'packet_branch serviceCmd=%j seqId=%d branch=push_context_invalid',
      pkt.serviceCmd,
      pkt.seqId,
    ]);
    return [];
  }

  // #137/#266: mirror QQ NT `sys_msg_mgr.cc::ProcessRecvSysMsg` before
  // dispatch. Its static routing table is the scope boundary: listed routes
  // use the native global key, while unlisted routes fail open. Running this
  // before registry decode also covers native system packets whose outer type
  // SnowLuma otherwise interprets as a chat message or does not decode at all.
  if (dedup) {
    const dedupIdentity = deriveSysMsgDedupIdentity(ctx);
    if (dedupIdentity && dedup.seenDuplicate(dedupIdentity)) {
      log.trace(() => [
        'packet_branch serviceCmd=%j seqId=%d branch=duplicate_system_push peer=%j chatType=%d messageSeq=%d messageRandom=%d',
        pkt.serviceCmd,
        pkt.seqId,
        dedupIdentity.peerUid,
        dedupIdentity.chatType,
        dedupIdentity.sequence,
        dedupIdentity.random,
      ]);
      log.debug(
        'dropped duplicate system push (peer=%s chatType=%d seq=%d msgType=%d/%d msgId=%d)',
        dedupIdentity.peerUid,
        dedupIdentity.chatType,
        ctx.head.sequence,
        ctx.head.msgType,
        ctx.head.subType,
        ctx.head.msgId,
      );
      return [];
    }
  }

  const events = throwDecoderErrors
    ? registry.decodeOrThrow(ctx)
    : registry.decode(ctx);
  const out = events.filter((ev) => {
    const elements = messageElements(ev);
    if (elements === undefined) return true;
    const survival = classifyMessageSurvival(ctx.head, elements, ctx.body);
    if (survival === 'drop-control') {
      log.trace(() => [
        'packet_branch serviceCmd=%j seqId=%d branch=c2c_control_push msgType=%d subType=%d c2cCmd=%d messageSeq=%d',
        pkt.serviceCmd,
        pkt.seqId,
        ctx.head.msgType,
        ctx.head.subType,
        ctx.head.c2cCmd,
        ctx.head.sequence,
      ]);
      if (elements.length > 0) {
        log.debug('dropped c2c control push that carried %d element(s) (kind=%s seq=%d from=%d msgType=%d cmd=%d)',
          elements.length, ev.kind, ctx.head.sequence, ctx.fromUin, ctx.head.msgType, ctx.head.c2cCmd);
      }
      return false;
    }
    if (survival === 'drop-blank') {
      log.trace(() => [
        'packet_branch serviceCmd=%j seqId=%d branch=empty_message msgType=%d subType=%d messageSeq=%d',
        pkt.serviceCmd,
        pkt.seqId,
        ctx.head.msgType,
        ctx.head.subType,
        ctx.head.sequence,
      ]);
      return false;
    }
    if (survival === 'keep-undecoded') {
      warnUndecodedMessage({
        kind: ev.kind,
        sequence: ctx.head.sequence,
        fromUin: ctx.fromUin,
        msgType: ctx.head.msgType,
        subType: ctx.head.subType,
        body: ctx.body,
      });
    }
    warnMissingC2cSequence(ev, ctx.fromUin);
    return true;
  });

  return out;
}
