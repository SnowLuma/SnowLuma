export interface UserProfileInfo {
  uin: number;
  uid: string;
  nickname: string;
  remark: string;
  qid: string;
  sex: string;
  age: number;
  sign: string;
  avatar: string;
  /** QQ 等级 — OIDB 0xFE1_2 number-property key 105.
   *  Already requested in `fetchUserProfile` keys[]; LagrangeV2
   *  `FetchStrangerService.cs` confirms `// Level`. */
  level: number;
}

export interface FriendInfo {
  uin: number;
  uid: string;
  nickname: string;
  remark: string;
}

export interface FriendCategoryInfo {
  categoryId: number;
  categoryName: string;
  memberCount: number;
  sortId: number;
  friends: FriendInfo[];
}

export interface GroupMemberInfo {
  uin: number;
  uid: string;
  nickname: string;
  card: string;
  /** Undefined until QQ's server-provided robot ranges classify this member. */
  isRobot?: boolean;
  role: string;       // 'owner' | 'admin' | 'member'
  level: number;
  title: string;
  joinTime: number;
  lastSentTime: number;
  shutUpTime: number;
}

export interface QQGroupInfo {
  groupId: number;
  groupName: string;
  remark: string;
  memberCount: number;
  memberMax: number;
  members: Map<number, GroupMemberInfo>;
  /** Group creation time (unix seconds). 0 when unknown (#197). */
  createTime?: number;
  /** Group level. Only the 0x88D_0 detail carries it; 0 from the list (#197). */
  level?: number;
  /** Group memo / announcement preview. '' when unknown (#197). */
  memo?: string;
}

export interface GroupRequestInfo {
  groupId: number;
  groupName: string;
  targetUid: string;
  targetUin: number;
  targetName: string;
  invitorUid: string;
  invitorUin: number;
  invitorName: string;
  operatorUid: string;
  operatorUin: number;
  operatorName: string;
  sequence: number;
  state: number;
  eventType: number;
  comment: string;
  filtered: boolean;
}

/** Approval tuple required by OIDB 0x10C8. The OneBot flag is opaque to
 * clients, but carrying the complete tuple makes delayed handling stateless. */
export type GroupRequestHandle = Pick<
  GroupRequestInfo,
  'sequence' | 'groupId' | 'eventType' | 'filtered'
>;

/** Canonical SnowLuma group-request flag (version 1). */
export function formatGroupRequestFlag(handle: GroupRequestHandle): string {
  return [
    'slreq',
    '1',
    handle.sequence,
    handle.groupId,
    handle.eventType,
    handle.filtered ? 1 : 0,
  ].join(':');
}
