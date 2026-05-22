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
