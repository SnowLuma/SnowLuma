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
  const userUin = resolveUidToUin(ctx.identity, groupId, adminUid, ctx.fromUin);

  // Keep the in-memory member cache in step with the promotion/demotion.
  // `get_group_member_info` serves straight from this cache on its
  // default (no_cache=false) path — and we deliberately *don't*
  // force-refresh there, because clients like OlivaDice/MaiBot query it
  // once per inbound message and a per-message OIDB refetch trips
  // Tencent risk-control (see the ContactsApi member-list cache). So if
  // we don't patch the role here, a freshly-promoted admin keeps reading
  // back as `member` until the member-list TTL lapses, and permission
  // gates reject their commands (#93). Only touch a member we already
  // know, and never downgrade the owner.
  const cached = ctx.identity.findGroupMember(groupId, userUin);
  if (cached && cached.role !== 'owner') {
    ctx.identity.updateGroupMember(groupId, { ...cached, role: set ? 'admin' : 'member' });
  }

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
