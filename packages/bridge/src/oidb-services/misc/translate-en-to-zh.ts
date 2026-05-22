// 0x990_2 — server-side English → Chinese translation. Returns the
// translated `dstWords` 1:1 paired with the input `words`. Magic
// constants `tag10=1` / `tag12=1` are documented as "always 1" in
// production traffic (purpose unknown).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x990Req, Oidb0x990Resp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace TranslateEnToZh {
  export const command = 0x990;
  export const subCommand = 2;

  export interface Params {
    words: string[];
  }

  export type Deps = OidbSender;

  export const serialize = (p: Params): Oidb0x990Req => ({
    translateReq: {
      srcLang: 'en',
      dstLang: 'zh',
      words: p.words,
    },
    tag10: 1,
    tag12: 1,
  });

  export const deserialize = (body: Oidb0x990Resp): string[] => {
    const resp = body.translateResp;
    if (!resp) throw new Error('translate response empty');
    return resp.dstWords || [];
  };

  export const encode = (env: OidbBase<Oidb0x990Req>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0x990Req>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0x990Resp> =>
    protobuf_decode<OidbBase<Oidb0x990Resp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<string[]> =>
    invokeOidb(deps, TranslateEnToZh, params);
}
