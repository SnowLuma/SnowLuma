// 0x102A_0 — request p_skey cookies for a list of qq.com subdomains.
// Used as the fallback when ptlogin2 jump doesn't emit a p_skey on
// the cookie set (intermittent server behaviour).

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { OidbGetPskeyReq, OidbGetPskeyResp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace GetPskey {
  export const command = 0x102A;
  export const subCommand = 0;

  export interface Params {
    domainList: string[];
  }

  export interface Result {
    domainPskeyMap: Map<string, string>;
  }

  export type Deps = OidbSender;

  export const serialize = (p: Params): OidbGetPskeyReq => ({
    domainList: p.domainList,
  });

  export const deserialize = (body: OidbGetPskeyResp): Result => {
    const domainPskeyMap = new Map<string, string>();
    if (body.pskeyItems && Array.isArray(body.pskeyItems)) {
      for (const item of body.pskeyItems) {
        if (item.domain && item.pskey) {
          domainPskeyMap.set(item.domain, item.pskey);
        }
      }
    }
    return { domainPskeyMap };
  };

  export const encode = (env: OidbBase<OidbGetPskeyReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGetPskeyReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGetPskeyResp> =>
    protobuf_decode<OidbBase<OidbGetPskeyResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<Result> =>
    invokeOidb(deps, GetPskey, params);
}
