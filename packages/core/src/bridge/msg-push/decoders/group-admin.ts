// Handles GroupAdminChangedNotice (44). extraEnable / extraDisable
// distinguishes set vs. unset.

import { protoDecode } from '../../../protobuf/decode';
import { GroupAdminSchema } from '../../proto/notify';
import type { GroupAdminEvent } from '../../events';
import type { MsgPushDecoder } from '../registry';
import { resolveUidToUin } from '../helpers';

export const decodeGroupAdmin: MsgPushDecoder = (ctx) => {
  const admin = protoDecode(ctx.content, GroupAdminSchema);
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
