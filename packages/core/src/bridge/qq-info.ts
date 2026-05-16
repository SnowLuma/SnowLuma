// Domain object shapes shared by IdentityService and its callers. The
// concrete state (own UIN, friends list, group rosters, profile cache)
// lives inside IdentityService — these interfaces just describe the
// records that flow across remember*/refresh* and find* boundaries.

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
}

export interface FriendInfo {
  uin: number;
  uid: string;
  nickname: string;
  remark: string;
}

export interface GroupMemberInfo {
  uin: number;
  uid: string;
  nickname: string;
  card: string;
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
