// GroupAdminApi — facade over Tier-2 napcat-parity group admin OIDB
// cmds (mute / kick / admin / card / name / title / leave / join-policy
// / add-request handling / @everyone budget). Every method is a
// one-line forwarder to a self-contained namespace under
// @snowluma/protocol/oidb-services/group-admin.
//
// The Apis facade keeps `bridge.apis.groupAdmin.X()` as the ergonomic
// call site; the per-(cmd, subcmd) namespaces own the wire shape and
// minimal capability surface.

import type { BridgeContext } from '../bridge-context';
import { MuteMember } from '@snowluma/protocol/oidb-services/group-admin/mute-member';
import { MuteAll } from '@snowluma/protocol/oidb-services/group-admin/mute-all';
import { SetAddOption } from '@snowluma/protocol/oidb-services/group-admin/set-add-option';
import { SetSearch } from '@snowluma/protocol/oidb-services/group-admin/set-search';
import { SetAddRequest } from '@snowluma/protocol/oidb-services/group-admin/set-add-request';
import { KickMember } from '@snowluma/protocol/oidb-services/group-admin/kick-member';
import { KickMembers } from '@snowluma/protocol/oidb-services/group-admin/kick-members';
import { LeaveGroup } from '@snowluma/protocol/oidb-services/group-admin/leave-group';
import { SetAdmin } from '@snowluma/protocol/oidb-services/group-admin/set-admin';
import { SetMemberCard } from '@snowluma/protocol/oidb-services/group-admin/set-member-card';
import { SetGroupName } from '@snowluma/protocol/oidb-services/group-admin/set-group-name';
import { SetSpecialTitle } from '@snowluma/protocol/oidb-services/group-admin/set-special-title';
import { SetGroupRemark } from '@snowluma/protocol/oidb-services/group-admin/set-group-remark';
import { GetAtAllRemain } from '@snowluma/protocol/oidb-services/group-admin/get-at-all-remain';

export class GroupAdminApi {
  constructor(private readonly ctx: BridgeContext) {}

  muteMember(groupId: number, userId: number, duration: number): Promise<void> {
    return MuteMember.invoke(this.ctx, { groupId, userId, duration });
  }

  muteAll(groupId: number, enable: boolean): Promise<void> {
    return MuteAll.invoke(this.ctx, { groupId, enable });
  }

  setAddOption(groupId: number, addType: number): Promise<void> {
    return SetAddOption.invoke(this.ctx, { groupId, addType });
  }

  setSearch(groupId: number): Promise<void> {
    return SetSearch.invoke(this.ctx, { groupId });
  }

  setAddRequest(
    groupId: number, sequence: number, eventType: number,
    approve: boolean, reason = '', filtered = false,
  ): Promise<void> {
    return SetAddRequest.invoke(this.ctx, { groupId, sequence, eventType, approve, reason, filtered });
  }

  kickMember(groupId: number, userId: number, reject: boolean, reason = ''): Promise<void> {
    return KickMember.invoke(this.ctx, { groupId, userId, reject, reason });
  }

  kickMembers(groupId: number, userIds: number[], reject: boolean): Promise<void> {
    return KickMembers.invoke(this.ctx, { groupId, userIds, reject });
  }

  leave(groupId: number): Promise<void> {
    return LeaveGroup.invoke(this.ctx, { groupId });
  }

  setAdmin(groupId: number, userId: number, enable: boolean): Promise<void> {
    return SetAdmin.invoke(this.ctx, { groupId, userId, enable });
  }

  setCard(groupId: number, userId: number, card: string): Promise<void> {
    return SetMemberCard.invoke(this.ctx, { groupId, userId, card });
  }

  setName(groupId: number, name: string): Promise<void> {
    return SetGroupName.invoke(this.ctx, { groupId, name });
  }

  setSpecialTitle(groupId: number, userId: number, title: string): Promise<void> {
    return SetSpecialTitle.invoke(this.ctx, { groupId, userId, title });
  }

  /**
   * The bot's local-only label for a group. Lives here rather than
   * `FriendApi` because the semantic is "operate on a group" rather
   * than "operate on a contact list".
   */
  setRemark(groupId: number, remark: string): Promise<void> {
    return SetGroupRemark.invoke(this.ctx, { groupId, remark });
  }

  getAtAllRemain(groupId: number): Promise<{
    can_at_all: boolean;
    remain_at_all_count_for_group: number;
    remain_at_all_count_for_uin: number;
  }> {
    return GetAtAllRemain.invoke(this.ctx, { groupId });
  }
}
