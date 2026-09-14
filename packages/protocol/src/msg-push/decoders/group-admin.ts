import { protobuf_decode } from '@snowluma/proton';
import type { GroupAdminEvent } from '../../events';
import type { GroupAdmin } from '@snowluma/proto-defs/notify';
import { resolveUidToUin } from '../helpers';
import type { MsgPushDecoder } from '../registry';

export const decodeGroupAdmin: MsgPushDecoder = (ctx) => {
  const admin = protobuf_decode<GroupAdmin>(ctx.content);
  if (!admin?.body) return [];
  // proton materializes an *absent* embedded-message field as an empty
  // `{}` rather than leaving it undefined, so the old
  // `extraEnable !== undefined` promote/demote test was always true and
  // every demote got reported as a promotion (with a fallback userUin).
  // The live sub-message is the one that actually carries an `adminUid`
  // — key off that instead.
  const enableUid = admin.body.extraEnable?.adminUid;
  const disableUid = admin.body.extraDisable?.adminUid;
  const adminUid = enableUid || disableUid;
  if (!adminUid) return [];
  const groupId = admin.groupUin ?? 0;
  const set = !!enableUid;
  const userUin = resolveUidToUin(ctx.identity, groupId, adminUid);

  const ev: GroupAdminEvent = {
    kind: 'group_admin',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId,
    userUin,
    set,
  };
  return [ev];
};
