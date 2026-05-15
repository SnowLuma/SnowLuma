// Operations that touch the bot's own profile / status, plus the
// related queries about my profile likes and unidirectional friends.
// All of these read/write fields on the self-uin via OIDB.

import type { Bridge } from '../bridge';
import { protoDecode, protoEncode } from '../../protobuf/decode';
import { runOidb } from '../bridge-oidb';
import { fetchHighwaySession, uploadHighwayHttp } from '../highway/highway-client';
import { computeHashes, loadBinarySource } from '../highway/utils';
import {
  FaceroamOpReqSchema,
  FaceroamOpRespSchema,
  Oidb0x112aReqSchema,
  Oidb0x112aRespSchema,
  Oidb0x7edReqSchema,
  Oidb0x7edRespSchema,
  Oidb0xcd4ReqSchema,
  Oidb0xcd4RespSchema,
  Oidb0xe17ReqSchema,
  Oidb0xe17RespSchema,
  OidbSetProfileSchema,
  SetStatusReqSchema,
  SetStatusRespSchema,
} from '../proto/oidb-action';
import { resolveSelfUid } from './shared';

// ─────────────── status / profile setters ───────────────

export async function setOnlineStatus(
  bridge: Bridge,
  status: number,
  extStatus: number = 0,
  batteryStatus: number = 100,
): Promise<void> {
  await dispatchSetStatus(bridge, { status, extStatus, batteryStatus });
}

/**
 * DIY (custom) online status. napcat fixes status=10 / extStatus=2000
 * — the values QQ associates with "I have a custom status string" —
 * and threads the faceId / wording / faceType through the customExt
 * sub-message of the same SetStatus wire call.
 */
export async function setDiyOnlineStatus(
  bridge: Bridge,
  faceId: number,
  wording: string,
  faceType: number,
): Promise<void> {
  await dispatchSetStatus(bridge, {
    status: 10,
    extStatus: 2000,
    batteryStatus: 0,
    customExt: { faceId, text: wording, faceType },
  });
}

async function dispatchSetStatus(
  bridge: Bridge,
  value: {
    status: number;
    extStatus: number;
    batteryStatus: number;
    customExt?: { faceId: number; text: string; faceType: number };
  },
): Promise<void> {
  const request = protoEncode(value, SetStatusReqSchema);

  const result = await bridge.sendRawPacket('trpc.qq_new_tech.status_svc.StatusService.SetStatus', request);

  if (!result.success) {
    throw new Error(result.errorMessage || 'set online status failed (network/timeout)');
  }

  if (result.responseData && result.responseData.length > 0) {
    const resp = protoDecode(result.responseData, SetStatusRespSchema);
    if (!resp) {
      throw new Error(result.errorMessage || 'set online status failed (network/timeout)');
    }
    if (resp.errCode !== undefined && resp.errCode !== 0) {
      throw new Error(resp.errMsg || `set online status failed with errCode: ${resp.errCode}`);
    }
  }
}

export async function setProfile(
  bridge: Bridge,
  nickname?: string,
  personalNote?: string,
): Promise<void> {
  const uin = BigInt(bridge.identity.uin);
  const stringProfiles: any[] = [];
  const intProfiles: any[] = [];

  if (nickname !== undefined) {
    stringProfiles.push({ fieldId: 20002, value: nickname });
  }

  if (personalNote !== undefined) {
    stringProfiles.push({ fieldId: 102, value: personalNote });
  }

  if (stringProfiles.length === 0 && intProfiles.length === 0) {
    return;
  }

  const req = {
    uin,
    stringProfiles,
  };

  await runOidb(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x112a_2',
    oidbCmd: 0x112A, subCmd: 2,
    request: { schema: OidbSetProfileSchema, value: req },
  });
}

export async function setSelfLongNick(
  bridge: Bridge,
  longNick: string,
) {
  const req = {
    uin: BigInt(bridge.identity.uin),
    profile: {
      tag: 102,
      value: String(longNick),
    },
  };

  await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x112a_2',
    oidbCmd: 0x112A, subCmd: 2,
    request: { schema: Oidb0x112aReqSchema, value: req },
    response: { schema: Oidb0x112aRespSchema },
  });
}

export async function setInputStatus(
  bridge: Bridge,
  userId: number,
  eventType: number,
) {
  const targetUid = await bridge.resolveUserUid(userId);

  if (!targetUid) {
    throw new Error('target uid not found');
  }

  const req = {
    reqBody: {
      uid: targetUid,
      chatType: 0,
      eventType: eventType,
    },
  };

  await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xcd4_1',
    oidbCmd: 0xCD4, subCmd: 1,
    request: { schema: Oidb0xcd4ReqSchema, value: req },
    response: { schema: Oidb0xcd4RespSchema },
  });
}

export async function setAvatar(
  bridge: Bridge,
  source: string,
): Promise<void> {
  const loaded = await loadBinarySource(source, 'avatar');
  if (!loaded.bytes.length) throw new Error('avatar file is empty');

  const hashes = computeHashes(loaded.bytes);
  const session = await fetchHighwaySession(bridge);
  await uploadHighwayHttp(bridge, session, 90, loaded.bytes, hashes.md5, new Uint8Array(0));
}

// ─────────────── queries on me / my contacts ───────────────

export async function getProfileLike(
  bridge: Bridge,
  userId?: number,
  start: number = 0,
  limit: number = 10,
) {
  const isSelf = !userId;
  const targetUid = isSelf
    ? await resolveSelfUid(bridge)
    : await bridge.resolveUserUid(userId);

  if (!targetUid) {
    throw new Error('target uid not found');
  }

  const req = {
    targetUid: targetUid,
    basic: 1,
    vote: 1,
    favorite: 1,
    start: start,
    limit: limit,
  };

  const result = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x7ed_12',
    oidbCmd: 0x7ED, subCmd: 12,
    request: { schema: Oidb0x7edReqSchema, value: req },
    response: { schema: Oidb0x7edRespSchema },
  });

  const data = result?.userLikeInfos?.[0];
  if (!data) {
    throw new Error('get profile like info empty');
  }

  return {
    uid: data.uid,
    time: Number(data.time),
    favoriteInfo: {
      total_count: data.favoriteInfo?.totalCount || 0,
      last_time: Number(data.favoriteInfo?.lastTime || 0),
      today_count: data.favoriteInfo?.newCount || 0,
      userInfos: [],
    },
    voteInfo: {
      total_count: data.voteInfo?.totalCount || 0,
      new_count: data.voteInfo?.newCount || 0,
      new_nearby_count: 0,
      last_visit_time: Number(data.voteInfo?.lastTime || 0),
      userInfos: [],
    },
  };
}

export async function getUnidirectionalFriendList(
  bridge: Bridge,
) {
  const reqObj = {
    uint64_uin: String(bridge.identity.uin),
    uint64_top: 0,
    uint32_req_num: 99,
    bytes_cookies: '',
  };

  const req = {
    jsonBody: JSON.stringify(reqObj),
  };

  const result = await runOidb<any>(bridge, {
    cmd: 'MQUpdateSvc_com_qq_ti.web.OidbSvc.0xe17_0',
    oidbCmd: 0xE17, subCmd: 0,
    request: { schema: Oidb0xe17ReqSchema, value: req },
    response: { schema: Oidb0xe17RespSchema },
  });

  if (!result || !result.jsonBody) {
    throw new Error('get unidirectional friend list empty');
  }

  const parsed = JSON.parse(result.jsonBody);
  return parsed.rpt_block_list || [];
}

export async function fetchCustomFace(bridge: Bridge, count: number = 10): Promise<string[]> {
  const req = {
    inner: { field1: 1, osVersion: '10.0.26200', qqVersion: '9.9.28-46928' },
    uin: BigInt(bridge.identity.uin),
    field3: 1,
    field6: 1,
  };
  const request = protoEncode(req, FaceroamOpReqSchema);
  const result = await bridge.sendRawPacket('Faceroam.OpReq', request);
  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'fetch custom face failed');
  }
  const resp = protoDecode(result.responseData, FaceroamOpRespSchema);
  if (!resp || (resp as any).retCode !== 0) {
    throw new Error(`fetch custom face error: ${(resp as any)?.message || 'unknown'}`);
  }
  const faceIds = (resp as any).item?.faceIds || [];
  return faceIds.slice(0, count).map((id: string) => `https://p.qpic.cn/qq_expression/${bridge.identity.uin}/${id}/0`);
}
