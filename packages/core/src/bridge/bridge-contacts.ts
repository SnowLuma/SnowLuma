// Contact / info-fetching operations extracted from Bridge.

import type { Bridge } from './bridge';
import type { DownloadRKeyInfo } from './bridge';
import type { FriendInfo, QQGroupInfo, GroupMemberInfo, UserProfileInfo, GroupRequestInfo } from './qq-info';
import { protoDecode } from '../protobuf/decode';
import { runOidb } from './bridge-oidb';
import {
  OidbSvcTrpcTcp0xFD4_1ResponseSchema,
  OidbSvcTrpcTcp0xFE5_2ResponseSchema,
  OidbSvcTrpcTcp0xFE7_3ResponseSchema,
  OidbSvcTrpcTcp0x10C0ResponseSchema,
} from './proto/oidb';
import {
  OidbFriendListRequestSchema,
  OidbGroupListRequestSchema,
  OidbGroupMemberListRequestSchema,
  OidbUserInfoRequestSchema,
  OidbUserInfoResponseSchema,
  AvatarInfoSchema,
  OidbGroupRequestListSchema,
  NTV2RichMediaReqSchema,
  NTV2RichMediaRespSchema,
} from './proto/oidb-action';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

export function buildFriendProperties(raw: any): Map<number, string> {
  const props = new Map<number, string>();
  for (const additional of raw.additional ?? []) {
    if ((additional.type ?? 0) !== 1 || !additional.layer1) continue;
    for (const property of additional.layer1.properties ?? []) {
      props.set(property.code ?? 0, property.value ?? '');
    }
  }
  return props;
}

export function permissionToRole(permission: number): string {
  switch (permission) {
    case 1: return 'owner';
    case 2: return 'admin';
    default: return 'member';
  }
}

// ---------------------------------------------------------------------------
// Friend list
// ---------------------------------------------------------------------------

export async function fetchFriendList(bridge: Bridge): Promise<FriendInfo[]> {
  const friends: FriendInfo[] = [];
  let nextUin: number | null = null;

  do {
    const body: any = {
      friendCount: 300,
      field4: 0,
      field6: 1,
      field7: 0x7FFFFFFF,
      body: [
        { type: 1, number: { numbers: [103, 102, 20002, 27394] } },
        { type: 4, number: { numbers: [100, 101, 102] } },
      ],
      field10002: [13578, 13579, 13573, 13572, 13568],
      field10003: 4051,
    };
    if (nextUin !== null) {
      body.nextUin = { uin: nextUin };
    }

    const resp = await runOidb<any>(bridge, {
      cmd: 'OidbSvcTrpcTcp.0xfd4_1',
      oidbCmd: 0xFD4, subCmd: 1,
      request: { schema: OidbFriendListRequestSchema, value: body },
      response: { schema: OidbSvcTrpcTcp0xFD4_1ResponseSchema },
    });

    if (resp?.friends) {
      for (const raw of resp.friends) {
        const props = buildFriendProperties(raw);
        friends.push({
          uin: raw.uin ?? 0,
          uid: raw.uid ?? '',
          nickname: props.get(20002) ?? String(raw.uin ?? 0),
          remark: props.get(103) ?? '',
        });
      }
    }

    nextUin = resp?.next?.uin ?? null;
    if (nextUin === 0) nextUin = null;
  } while (nextUin !== null);

  bridge.identity.rememberFriends(friends);
  return friends;
}

// ---------------------------------------------------------------------------
// Group list
// ---------------------------------------------------------------------------

export async function fetchGroupList(bridge: Bridge): Promise<QQGroupInfo[]> {
  const allTrue = true;
  const body = {
    config: {
      config1: {
        groupOwner: allTrue, field2: allTrue, memberMax: allTrue, memberCount: allTrue,
        groupName: allTrue, field8: allTrue, field9: allTrue, field10: allTrue,
        field11: allTrue, field12: allTrue, field13: allTrue, field14: allTrue,
        field15: allTrue, field16: allTrue, field17: allTrue, field18: allTrue,
        question: allTrue, field20: allTrue, field22: allTrue, field23: allTrue,
        field24: allTrue, field25: allTrue, field26: allTrue, field27: allTrue,
        field28: allTrue, field29: allTrue, field30: allTrue, field31: allTrue,
        field32: allTrue, field5001: allTrue, field5002: allTrue, field5003: allTrue,
      },
      config2: {
        field1: allTrue, field2: allTrue, field3: allTrue, field4: allTrue,
        field5: allTrue, field6: allTrue, field7: allTrue, field8: allTrue,
      },
      config3: { field5: allTrue, field6: allTrue },
    },
  };

  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xfe5_2',
    oidbCmd: 0xFE5, subCmd: 2,
    request: { schema: OidbGroupListRequestSchema, value: body, isUid: true },
    response: { schema: OidbSvcTrpcTcp0xFE5_2ResponseSchema },
  });

  const groups: QQGroupInfo[] = [];
  if (resp?.groups) {
    for (const raw of resp.groups) {
      groups.push({
        groupId: raw.groupUin ?? 0,
        groupName: raw.info?.groupName ?? '',
        remark: raw.customInfo?.remark ?? '',
        memberCount: raw.info?.memberCount ?? 0,
        memberMax: raw.info?.memberMax ?? 0,
        members: new Map(),
      });
    }
  }
  bridge.identity.rememberGroups(groups);
  return groups;
}

// ---------------------------------------------------------------------------
// Group member list
// ---------------------------------------------------------------------------

export async function fetchGroupMemberList(bridge: Bridge, groupId: number): Promise<GroupMemberInfo[]> {
  const members: GroupMemberInfo[] = [];
  let token = '';

  do {
    const body: any = {
      groupUin: groupId,
      field2: 5,
      field3: 2,
      body: {
        memberName: true, memberCard: true, level: true, field13: true,
        field16: true, specialTitle: true, field18: true, field20: true,
        field21: true, joinTimestamp: true, lastMsgTimestamp: true,
        shutUpTimestamp: true, field103: true, field104: true, field105: true,
        field106: true, permission: true, field200: true, field201: true,
      },
    };
    if (token) body.token = token;

    const resp = await runOidb<any>(bridge, {
      cmd: 'OidbSvcTrpcTcp.0xfe7_3',
      oidbCmd: 0xFE7, subCmd: 3,
      request: { schema: OidbGroupMemberListRequestSchema, value: body },
      response: { schema: OidbSvcTrpcTcp0xFE7_3ResponseSchema },
    });

    if (resp?.members) {
      for (const raw of resp.members) {
        members.push({
          uin: raw.uin?.uin ?? 0,
          uid: raw.uin?.uid ?? '',
          nickname: raw.memberName ?? '',
          card: raw.memberCard?.memberCard ?? '',
          role: permissionToRole(raw.permission ?? 0),
          level: raw.level?.level ?? 0,
          title: raw.specialTitle ?? '',
          joinTime: raw.joinTimestamp ?? 0,
          lastSentTime: raw.lastMsgTimestamp ?? 0,
          shutUpTime: raw.shutUpTimestamp ?? 0,
        });
      }
    }

    token = resp?.token ?? '';
  } while (token);

  bridge.identity.rememberGroupMembers(groupId, members);
  return members;
}

// ---------------------------------------------------------------------------
// User profile
// ---------------------------------------------------------------------------

export async function fetchUserProfile(bridge: Bridge, uin: number): Promise<UserProfileInfo> {
  const keys = [20002, 27394, 20009, 20031, 101, 103, 102, 20020, 20003, 20026, 105, 27372, 27406, 20037];
  const body = {
    uin,
    field2: 0,
    keys: keys.map(k => ({ key: k })),
  };

  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xfe1_2',
    oidbCmd: 0xFE1, subCmd: 2,
    request: { schema: OidbUserInfoRequestSchema, value: body },
    response: { schema: OidbUserInfoResponseSchema },
  });

  if (!resp?.body) throw new Error('user info response body missing');

  const info: UserProfileInfo = {
    uin: resp.body.uin ?? uin,
    uid: resp.body.uid ?? '',
    nickname: '', remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '',
  };

  if (resp.body.properties) {
    const bytesMap = new Map<number, Uint8Array>();
    const numMap = new Map<number, number>();
    for (const bp of resp.body.properties.bytesProperties ?? []) {
      bytesMap.set(bp.code ?? 0, bp.value ?? new Uint8Array(0));
    }
    for (const np of resp.body.properties.numberProperties ?? []) {
      numMap.set(np.number1 ?? 0, np.number2 ?? 0);
    }

    const getString = (code: number) => {
      const b = bytesMap.get(code);
      return b ? Buffer.from(b).toString('utf8') : '';
    };

    info.nickname = getString(20002);
    info.remark = getString(103);
    info.qid = getString(27394);
    info.sign = getString(102);

    const avatarBytes = bytesMap.get(101);
    if (avatarBytes) {
      const av = protoDecode(avatarBytes, AvatarInfoSchema);
      if (av?.url) info.avatar = av.url + '640';
    }

    const sexNum = numMap.get(20009) ?? 0;
    info.sex = sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown';
    info.age = numMap.get(20037) ?? 0;
  }

  bridge.identity.rememberUserProfile(info);
  return info;
}

// ---------------------------------------------------------------------------
// Group requests
// ---------------------------------------------------------------------------

export async function fetchGroupRequests(bridge: Bridge, filtered = false): Promise<GroupRequestInfo[]> {
  const subCmd = filtered ? 2 : 1;
  const cmd = filtered ? 'OidbSvcTrpcTcp.0x10c0_2' : 'OidbSvcTrpcTcp.0x10c0_1';
  const resp = await runOidb<any>(bridge, {
    cmd,
    oidbCmd: 0x10C0, subCmd,
    request: { schema: OidbGroupRequestListSchema, value: { count: 20, field2: 0 } },
    response: { schema: OidbSvcTrpcTcp0x10C0ResponseSchema },
  });

  const requests: GroupRequestInfo[] = [];
  for (const raw of resp?.requests ?? []) {
    requests.push({
      groupId: raw.group?.groupUin ?? 0,
      groupName: raw.group?.groupName ?? '',
      targetUid: raw.target?.uid ?? '',
      targetUin: 0,
      targetName: raw.target?.name ?? '',
      invitorUid: raw.invitor?.uid ?? '',
      invitorUin: 0,
      invitorName: raw.invitor?.name ?? '',
      operatorUid: raw.operatorUser?.uid ?? '',
      operatorUin: 0,
      operatorName: raw.operatorUser?.name ?? '',
      sequence: Number(raw.sequence ?? 0),
      state: raw.state ?? 0,
      eventType: raw.eventType ?? 0,
      comment: raw.comment ?? '',
      filtered,
    });
  }
  bridge.identity.rememberGroupRequests(requests);
  return requests;
}

// ---------------------------------------------------------------------------
// Download RKeys
// ---------------------------------------------------------------------------

export async function fetchDownloadRKeys(bridge: Bridge): Promise<DownloadRKeyInfo[]> {
  const PRIVATE_IMAGE = 10;
  const GROUP_IMAGE = 20;
  const FALLBACK_IMAGE = 2;

  const body = {
    reqHead: {
      common: { requestId: 1, command: 202 },
      scene: { requestType: 2, businessType: 1, sceneType: 0 },
      client: { agentType: 2 },
    },
    downloadRkey: {
      types: [PRIVATE_IMAGE, GROUP_IMAGE, FALLBACK_IMAGE],
    },
  };

  const resp = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x9067_202',
    oidbCmd: 0x9067, subCmd: 202,
    request: { schema: NTV2RichMediaReqSchema, value: body, isUid: true },
    response: { schema: NTV2RichMediaRespSchema },
  });

  if (resp?.respHead?.retCode && resp.respHead.retCode !== 0) {
    throw new Error(resp.respHead.message ?? 'fetch download rkey failed');
  }

  const result: DownloadRKeyInfo[] = [];
  for (const entry of resp?.downloadRkey?.rkeys ?? []) {
    const rkey = entry.rkey ?? '';
    const type = entry.type ?? 0;
    if (rkey && type) {
      result.push({
        rkey,
        ttlSeconds: Number(entry.rkeyTtlSec ?? 0),
        storeId: entry.storeId ?? 0,
        createTime: entry.rkeyCreateTime ?? 0,
        type,
      });
    }
  }
  return result;
}
