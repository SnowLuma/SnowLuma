// Grab-bag: action verbs that don't share a theme with anything else.
// Kept together so the directory stays small; if any of these grow new
// related siblings, lift the whole group out into its own file.

import type { Bridge } from '../bridge';
import { protoDecode, protoEncode } from '../../protobuf/decode';
import { runOidb } from '../bridge-oidb';
import {
  MiniAppShareReqSchema,
  MiniAppShareRespSchema,
  Oidb0x112eReqSchema,
  Oidb0x112eRespSchema,
  Oidb0x990ReqSchema,
  Oidb0x990RespSchema,
  Oidb0xeb7ReqSchema,
  Oidb0xeb7RespSchema,
} from '../proto/oidb-action';

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

  const result = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x990_2',
    oidbCmd: 0x990, subCmd: 2,
    request: { schema: Oidb0x990ReqSchema, value: req },
    response: { schema: Oidb0x990RespSchema },
  });

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

  const request = protoEncode({
    sdkVersion: 'V1_PC_MINISDK_99.99.99_1_APP_A',
    body: {
      appid,
      title,
      desc,
      picUrl,
      jumpUrl,
      iconUrl,
    },
  }, MiniAppShareReqSchema);

  const result = await bridge.sendRawPacket('LightAppSvc.mini_app_share.AdaptShareInfo', request);

  if (!result.success || !result.responseData) {
    throw new Error(result.errorMessage || 'get mini app ark failed');
  }

  const decoded = protoDecode(result.responseData, MiniAppShareRespSchema);
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

  const result = await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0x112e_1',
    oidbCmd: 0x112E, subCmd: 1,
    request: { schema: Oidb0x112eReqSchema, value: req },
    response: { schema: Oidb0x112eRespSchema },
  });

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

  await runOidb<any>(bridge, {
    cmd: 'OidbSvcTrpcTcp.0xEB7_1',
    oidbCmd: 0xEB7, subCmd: 1,
    request: { schema: Oidb0xeb7ReqSchema, value: req },
    response: { schema: Oidb0xeb7RespSchema },
  });
}
