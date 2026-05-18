// Handles GroupAdminChangedNotice (44). extraEnable / extraDisable
// distinguishes set vs. unset.

import { protobuf_decode } from '@snowluma/proton';
import type { GroupAdmin } from '../../proto/proton/notify';
import type { GroupAdminEvent } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { resolveUidToUin } from '../helpers';

export const decodeGroupAdmin: MsgPushDecoder = (ctx) => {
  const admin = protobuf_decode<GroupAdmin>(ctx.content);
  if (!admin?.body) return [];
  const extra = admin.body.extraEnable ?? admin.body.extraDisable;
  if (!extra) return [];
  const ev: GroupAdminEvent = {
    kind: 'group_admin',
    time: ctx.head.timestamp,
    selfUin: ctx.selfUin,
    groupId: admin.groupUin ?? 0,
    userUin: resolveUidToUin(ctx.identity, admin.groupUin ?? 0, extra.adminUid ?? '', ctx.fromUin),
    set: admin.body.extraEnable !== undefined,
  };
  return [ev];
};
