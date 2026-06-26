import type { JsonObject, JsonValue } from '@snowluma/common/json';
import type {
  MiniAppShareReq,
  MiniAppShareResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '../bridge-context';
// Migrated OIDB cmds — facade methods are one-line forwarders.
import { ClickInlineKeyboardButton } from '@snowluma/protocol/oidb-services/misc/click-inline-keyboard-button';
import { SendGroupSign } from '@snowluma/protocol/oidb-services/misc/send-group-sign';
import { TranslateEnToZh } from '@snowluma/protocol/oidb-services/misc/translate-en-to-zh';
import { RequestDbKey } from '@snowluma/protocol/oidb-services/misc/request-decrypt-key';
import { ImageOcr, type OcrResult } from '@snowluma/protocol/oidb-services/misc/image-ocr';

export class MiscApi {
  constructor(private readonly ctx: BridgeContext) { }

  translateEn2Zh(words: string[]): Promise<string[]> {
    return TranslateEnToZh.invoke(this.ctx, { words });
  }

  ocrImage(imageUrl: string): Promise<OcrResult> {
    return ImageOcr.invoke(this.ctx, { imageUrl });
  }

  async getMiniAppArk(type: string, title: string, desc: string, picUrl: string, jumpUrl: string): Promise<JsonObject> {
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

    const parsed = JSON.parse(jsonStr) as Record<string, JsonObject | string | number | boolean | null>;

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

  clickInlineKeyboardButton(
    groupId: number,
    botAppid: number,
    buttonId: string,
    callbackData: string,
    msgSeq: number,
  ): Promise<JsonValue> {
    return ClickInlineKeyboardButton.invoke(this.ctx, { groupId, botAppid, buttonId, callbackData, msgSeq });
  }

  sendGroupSign(groupId: number): Promise<void> {
    return SendGroupSign.invoke(this.ctx, { groupId });
  }

  async getDecryptKey(dbSalt: string): Promise<string> {
    const result = await RequestDbKey.invoke(this.ctx, { db_salt: dbSalt });
    if (!result.success) {
      throw new Error(result.errorMsg || `Failed to get decrypt key (code: ${result.errorCode})`);
    }
    if (!result.dbKey) {
      throw new Error('Decrypt key is empty');
    }
    return result.dbKey;
  }
}
