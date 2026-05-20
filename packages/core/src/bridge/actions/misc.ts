// Grab-bag: action verbs that don't share a theme with anything else.
// Kept together so the directory stays small; if any of these grow new
// related siblings, lift the whole group out into its own file.

import type { Bridge } from '../bridge';
import { runOidb, makeOidbEnvelope } from '../bridge-oidb';
import type {
  MiniAppShareReq,
  MiniAppShareResp,
  Oidb0x112eReq,
  Oidb0x112eResp,
  Oidb0x990Req,
  Oidb0x990Resp,
  Oidb0xeb7Req,
  Oidb0xeb7Resp,
} from '../proto/proton/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { OidbBase } from '../proto/proton/oidb';

export async function translateEn2Zh(
  bridge: Bridge,
  words: string[],
) {
  const req = {
    translateReq: {
      srcLang: 'en',
      dstLang: 'zh',
      words: words,
    },
    tag10: 1,
    tag12: 1,
  };

  const env = makeOidbEnvelope<Oidb0x990Req>(0x990, 2, req);
  const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x990_2', protobuf_encode<OidbBase<Oidb0x990Req>>(env));
  const result = protobuf_decode<OidbBase<Oidb0x990Resp>>(respBytes).body;

  const resp = result?.translateResp;
  if (!resp) {
    throw new Error('translate response empty');
  }

  return resp.dstWords || [];
}

export async function getMiniAppArk(
  bridge: Bridge,
  type: string,
  title: string,
  desc: string,
  picUrl: string,
  jumpUrl: string,
) {
  let appid = '1109937557'; // default: bilibili
  let iconUrl = 'http://miniapp.gtimg.cn/public/appicon/51f90239b78a2e4994c11215f4c4ba15_200.jpg';

  if (type === 'weibo') {
    appid = '1109224783';
    iconUrl = 'http://miniapp.gtimg.cn/public/appicon/35bbb44dc68e65194cfacfb206b8f1f7_200.jpg';
  } else if (type !== 'bili') {
    throw new Error(`unsupported type: ${type}, only support bili and weibo`);
  }

  const request = protobuf_encode<MiniAppShareReq>({
    sdkVersion: 'V1_PC_MINISDK_99.99.99_1_APP_A',
    body: {
      appid,
      title,
      desc,
      picUrl,
      jumpUrl,
      iconUrl,
    },
  });

  const result = await bridge.sendRawPacket('LightAppSvc.mini_app_share.AdaptShareInfo', request);

  if (!result.success || !result.responseData) {
    throw new Error(result.errorMessage || 'get mini app ark failed');
  }

  const decoded = protobuf_decode<MiniAppShareResp>(result.responseData);
  const jsonStr = decoded?.body?.jsonStr;

  if (!jsonStr) {
    throw new Error('mini app share json empty');
  }

  const parsed = JSON.parse(jsonStr);

  return {
    data: {
      ver: parsed.ver,
      prompt: parsed.prompt,
      config: parsed.config,
      app: parsed.appName,
      view: parsed.appView,
      meta: parsed.metaData,
      miniappShareOrigin: 3,
      miniappOpenRefer: '10002',
    },
  };
}

export async function clickInlineKeyboardButton(
  bridge: Bridge,
  groupId: number,
  botAppid: number,
  buttonId: string,
  callbackData: string,
  msgSeq: number,
) {
  const req = {
    botAppid: BigInt(botAppid),
    msgSeq: BigInt(msgSeq),
    buttonId: String(buttonId),
    callbackData: String(callbackData || ''),
    unknown7: 0,
    groupId: BigInt(groupId),
    unknown9: 1,
  };

  const env = makeOidbEnvelope<Oidb0x112eReq>(0x112E, 1, req);
  const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0x112e_1', protobuf_encode<OidbBase<Oidb0x112eReq>>(env));
  const result = protobuf_decode<OidbBase<Oidb0x112eResp>>(respBytes).body;

  if (!result) {
    throw new Error('click inline keyboard button result empty');
  }

  return {
    result: Number(result.result || 0),
    errMsg: result.errMsg || '',
    status: 0,
    promptText: result.promptText || '',
    promptType: 0,
    promptIcon: 0,
  };
}

export async function sendGroupSign(
  bridge: Bridge,
  groupId: number,
) {
  const req = {
    signInInfo: {
      uin: String(bridge.identity.uin),
      groupId: String(groupId),
      version: '9.0.90',
    },
  };

  const env = makeOidbEnvelope<Oidb0xeb7Req>(0xEB7, 1, req);
  const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xEB7_1', protobuf_encode<OidbBase<Oidb0xeb7Req>>(env));
  // Decode just to maintain the original behaviour of "consume the response".
  protobuf_decode<OidbBase<Oidb0xeb7Resp>>(respBytes);
}
