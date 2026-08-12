// 0xdc2_34 — send a custom 图文 (URL-share) ark card to a C2C peer or group.
// RE'd from QQ Android 9.3.25 captures. Fixed fields:
//   appId = 100446242, field2 = 1, field3 = 0, field5 = {1:1}
// targetId appears at AppInfo[11] and Meta[2]; Meta.peerType: 0=C2C, 1=group.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  Oidb0xdc2_34Req,
  Oidb0xdc2_34Resp,
} from '@snowluma/proto-defs/oidb-actions/contact-ark';
import { invokeOidb, type OidbSender } from '../../oidb-service';

const TUWEN_ARK_APPID = 100446242;

export type SendTuwenArkParams = {
  targetId:   number;
  peerType:   0 | 1;
  title:      string;
  desc:       string;
  summary:    string;
  jumpUrl:    string;
  previewUrl: string;
};

export namespace SendTuwenArk {
  export const command    = 0xDC2;
  export const subCommand = 34;
  export const uinForm    = false;

  export type Params = SendTuwenArkParams;
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0xdc2_34Req => ({
    appInfo: {
      appId:    TUWEN_ARK_APPID,
      field2:   1,
      field3:   0,
      field5:   { field1: 1 },
      targetId: p.targetId,
      content: {
        flag:       1,
        title:      p.title,
        desc:       p.desc,
        summary:    p.summary,
        jumpUrl:    p.jumpUrl,
        previewUrl: p.previewUrl,
      },
    },
    meta: {
      peerType: p.peerType,
      targetId: p.targetId,
    },
  });

  export const deserialize = (_ctx: Deps, _body: Oidb0xdc2_34Resp): void => undefined;

  export const encode = (env: OidbBase<Oidb0xdc2_34Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0xdc2_34Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0xdc2_34Resp> =>
    protobuf_decode<OidbBase<Oidb0xdc2_34Resp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, SendTuwenArk, params);
}
