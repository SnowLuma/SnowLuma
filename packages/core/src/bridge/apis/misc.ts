// MiscApi — odds & ends that don't fit the other Apis: translation,
// mini-app ARK build, inline-keyboard button click, group sign-in.
// Inlined from `actions/misc.ts` (deleted alongside actions/* in
// commit 13).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  MiniAppShareReq,
  MiniAppShareResp,
  Oidb0x112eReq,
  Oidb0x112eResp,
  Oidb0x990Req,
  Oidb0x990Resp,
  Oidb0xeb7Req,
  Oidb0xeb7Resp,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '@snowluma/bridge/bridge-oidb';

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

export class MiscApi {
  constructor(private readonly ctx: BridgeContext) {}

  async translateEn2Zh(words: string[]): Promise<string[]> {
    const bridge = asBridge(this.ctx);
    const req = {
      translateReq: {
        srcLang: 'en',
        dstLang: 'zh',
        words,
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

  async getMiniAppArk(type: string, title: string, desc: string, picUrl: string, jumpUrl: string): Promise<any> {
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
      body: { appid, title, desc, picUrl, jumpUrl, iconUrl },
    });

    const result = await this.ctx.sendRawPacket('LightAppSvc.mini_app_share.AdaptShareInfo', request);

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

  async clickInlineKeyboardButton(
    groupId: number,
    botAppid: number,
    buttonId: string,
    callbackData: string,
    msgSeq: number,
  ): Promise<any> {
    const bridge = asBridge(this.ctx);
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

  async sendGroupSign(groupId: number): Promise<void> {
    const bridge = asBridge(this.ctx);
    const req = {
      signInInfo: {
        uin: String(this.ctx.identity.uin),
        groupId: String(groupId),
        version: '9.0.90',
      },
    };

    const env = makeOidbEnvelope<Oidb0xeb7Req>(0xEB7, 1, req);
    const respBytes = await runOidb(bridge, 'OidbSvcTrpcTcp.0xEB7_1', protobuf_encode<OidbBase<Oidb0xeb7Req>>(env));
    protobuf_decode<OidbBase<Oidb0xeb7Resp>>(respBytes);
  }
}
