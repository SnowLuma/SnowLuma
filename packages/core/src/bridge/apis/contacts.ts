// ContactsApi — friend / group / member roster + user-profile +
// group-request-list + download-rkey OIDB calls.
//
// All implementations inlined from the previous `bridge-contacts.ts`
// (which gets removed alongside the rest of the actions/* facade
// shim in commit 13). The single non-trivial piece carried over is
// the per-group inflight + TTL cache for `fetchGroupMemberList`:
// without it a busy OneBot client (e.g. MaiBot calling
// `get_group_member_info` once per inbound message) would trigger
// one OIDB 0xfe7_3 per chat message, sustained >1k/h, which trips
// Tencent risk-control and gets the account banned for 7 days.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  OidbBase,
  OidbSvcTrpcTcp0x10C0Response,
  OidbSvcTrpcTcp0xFD4_1Response,
  OidbSvcTrpcTcp0xFE5_2Response,
  OidbSvcTrpcTcp0xFE7_3Response,
} from '@snowluma/proto-defs/oidb';
import type {
  AvatarInfo,
  OidbFriendListRequest,
  OidbGroupListRequest,
  OidbGroupMemberListRequest,
  OidbGroupRequestList,
  OidbUserInfoRequest,
  OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type {
  NTV2RichMediaReq,
  NTV2RichMediaResp,
} from '@snowluma/proto-defs/oidb-actions/media';
import type { BridgeContext } from '../bridge-context';
import type { DownloadRKeyInfo } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';
import type { Bridge } from '../bridge';
import type {
  FriendInfo,
  GroupMemberInfo,
  GroupRequestInfo,
  QQGroupInfo,
  UserProfileInfo,
} from '@snowluma/bridge/qq-info';

// ─── Helpers (previously in bridge-contacts.ts) ───────────────────

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

// `runOidb` and the proto-defs helpers take `Bridge` (deep dependency
// inside the highway / sendRawPacket plumbing). At runtime `ctx` IS
// the Bridge that constructed this Api, so narrowing back via
// `ctx as Bridge` is safe — see the same pattern in `MessageApi`
// where buildSendElems also expects a Bridge.
function asBridge(ctx: BridgeContext): Bridge {
  return ctx as unknown as Bridge;
}

const MEMBER_LIST_TTL_MS = 60_000;

export class ContactsApi {
  /**
   * Per-group inflight + last-fetch cache for `fetchGroupMemberList`.
   * Keyed by groupId, lives for the lifetime of the Bridge (so the
   * cache resets per account, as you'd expect for multi-account
   * runtimes — `BridgeManager` builds one Bridge per uin and each
   * gets its own ContactsApi).
   */
  private memberListInflight = new Map<number, Promise<GroupMemberInfo[]>>();
  private memberListLastFetch = new Map<number, { at: number; data: GroupMemberInfo[] }>();

  constructor(private readonly ctx: BridgeContext) {}

  async fetchFriendList(): Promise<FriendInfo[]> {
    const bridge = asBridge(this.ctx);
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
      const env = makeOidbEnvelope<OidbFriendListRequest>(0xFD4, 1, body);
      const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xfd4_1', protobuf_encode<OidbBase<OidbFriendListRequest>>(env));
      const resp = protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFD4_1Response>>(respBytes).body;

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

    this.ctx.identity.rememberFriends(friends);
    return friends;
  }

  async fetchGroupList(): Promise<QQGroupInfo[]> {
    const bridge = asBridge(this.ctx);
    // The config flags ask QQ which per-group fields to include in
    // the response. Asking for everything looks innocent on small
    // accounts but on ~200+ groups it makes the QQ NT process write
    // a payload large enough to blow the named-pipe write buffer —
    // we then read EPIPE and the whole session dies. See issue #42.
    // Keep `config1.*` mostly on but turn off the costly groups of
    // bools that never map back to a decoded field.
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
          field32: allTrue, field5001: allTrue, field5002: false, field5003: false,
        },
        config2: {
          field1: false, field2: false, field3: false, field4: false,
          field5: false, field6: false, field7: false, field8: false,
        },
        config3: { field5: allTrue, field6: allTrue },
      },
    };
    const env = makeOidbEnvelope<OidbGroupListRequest>(0xFE5, 2, body, true);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xfe5_2', protobuf_encode<OidbBase<OidbGroupListRequest>>(env));
    const resp = protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFE5_2Response>>(respBytes).body;

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
    this.ctx.identity.rememberGroups(groups);
    return groups;
  }

  async fetchGroupMemberList(
    groupId: number,
    options: { force?: boolean } = {},
  ): Promise<GroupMemberInfo[]> {
    // Coalesce in-flight calls + serve a 60s-cached result. Without
    // this, a busy OneBot client gets the bot 7-day banned within
    // hours via Tencent risk-control.
    const now = Date.now();
    const last = this.memberListLastFetch.get(groupId);
    if (!options.force && last && now - last.at < MEMBER_LIST_TTL_MS) {
      return last.data;
    }
    const inflight = this.memberListInflight.get(groupId);
    if (inflight) return inflight;
    const task = (async () => {
      try {
        const data = await this.fetchGroupMemberListUncached(groupId);
        this.memberListLastFetch.set(groupId, { at: Date.now(), data });
        return data;
      } finally {
        this.memberListInflight.delete(groupId);
      }
    })();
    this.memberListInflight.set(groupId, task);
    return task;
  }

  private async fetchGroupMemberListUncached(groupId: number): Promise<GroupMemberInfo[]> {
    const bridge = asBridge(this.ctx);
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
      const env = makeOidbEnvelope<OidbGroupMemberListRequest>(0xFE7, 3, body);
      const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xfe7_3', protobuf_encode<OidbBase<OidbGroupMemberListRequest>>(env));
      const resp = protobuf_decode<OidbBase<OidbSvcTrpcTcp0xFE7_3Response>>(respBytes).body;

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

    this.ctx.identity.rememberGroupMembers(groupId, members);
    return members;
  }

  async fetchUserProfile(uin: number): Promise<UserProfileInfo> {
    const bridge = asBridge(this.ctx);
    const keys = [20002, 27394, 20009, 20031, 101, 103, 102, 20020, 20003, 20026, 105, 27372, 27406, 20037];
    // Only `uin` and `keys` — see OidbUserInfoRequestSchema for why
    // sending field 2 makes the server reject the request.
    const body = {
      uin,
      keys: keys.map(k => ({ key: k })),
    };
    // Set OIDB envelope `reserved = 1` (the `isUid: true` flag — the
    // name is historical, the wire semantic is "this is the UIN-form
    // variant of the call"). Without it newer QQ NT versions take the
    // UID-form validation path, find neither uid nor openid in the
    // body and bounce the request with
    // `[oidb] one of uid/openid is invaild`. Matches Lagrange.Core's
    // FetchStrangerByUin (Reserved = 1).
    const env = makeOidbEnvelope<OidbUserInfoRequest>(0xFE1, 2, body, true);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xfe1_2', protobuf_encode<OidbBase<OidbUserInfoRequest>>(env));
    const resp = protobuf_decode<OidbBase<OidbUserInfoResponse>>(respBytes).body;

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
        const av = protobuf_decode<AvatarInfo>(avatarBytes);
        if (av?.url) info.avatar = av.url + '640';
      }
      const sexNum = numMap.get(20009) ?? 0;
      info.sex = sexNum === 1 ? 'male' : sexNum === 2 ? 'female' : 'unknown';
      info.age = numMap.get(20037) ?? 0;
    }

    this.ctx.identity.rememberUserProfile(info);
    return info;
  }

  async fetchGroupRequests(filtered = false): Promise<GroupRequestInfo[]> {
    const bridge = asBridge(this.ctx);
    const subCmd = filtered ? 2 : 1;
    const cmd = filtered ? 'OidbSvcTrpcTcp.0x10c0_2' : 'OidbSvcTrpcTcp.0x10c0_1';
    const env = makeOidbEnvelope<OidbGroupRequestList>(0x10C0, subCmd, { count: 20, field2: 0 });
    const respBytes = await runOidb(bridge, cmd, protobuf_encode<OidbBase<OidbGroupRequestList>>(env));
    const resp = protobuf_decode<OidbBase<OidbSvcTrpcTcp0x10C0Response>>(respBytes).body;

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
    this.ctx.identity.rememberGroupRequests(requests);
    return requests;
  }

  async fetchDownloadRKeys(): Promise<DownloadRKeyInfo[]> {
    const bridge = asBridge(this.ctx);
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
    const env = makeOidbEnvelope<NTV2RichMediaReq>(0x9067, 202, body, true);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x9067_202', protobuf_encode<OidbBase<NTV2RichMediaReq>>(env));
    const resp = protobuf_decode<OidbBase<NTV2RichMediaResp>>(respBytes).body;

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
}
