import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0xcdeReq, Oidb0xcdeResp } from '@snowluma/proto-defs/oidb-actions/base';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace RequestDbKey {
  export const command = 0xcde;
  export const subCommand = 2;

  export interface Params {
    db_salt: string;
    sessionData?: Uint8Array;
  }

  export interface Result {
    success: boolean;
    dbKey?: string;
    errorCode?: number;
    errorMsg?: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): Oidb0xcdeReq => {
    const req: Oidb0xcdeReq = {
      info: {
        db_salt: p.db_salt,
      }
    };
    if (p.sessionData) {
      req.sessionData = p.sessionData;
    }
    return req;
  };

  export const deserialize = (_ctx: Deps, body: Oidb0xcdeResp): string => {
    const dbKey = body.info?.dbKey;

    if (!dbKey) {
      throw new Error('Oidb 0xcde_2 payload empty (Missing dbKey)');
    }
    return dbKey;
  };

  export const encode = (env: OidbBase<Oidb0xcdeReq>): Uint8Array =>
    protobuf_encode<OidbBase<Oidb0xcdeReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<Oidb0xcdeResp> =>
    protobuf_decode<OidbBase<Oidb0xcdeResp>>(bytes);

  export const invoke = async (deps: Deps, params: Params): Promise<Result> => {
    try {
      const key = await invokeOidb(deps, RequestDbKey, params);
      return {
        success: true,
        dbKey: key,
      };
    } catch (error: any) {
      const code = error?.code ?? -1;

      return {
        success: false,
        errorCode: code,
        errorMsg: code === 1006
          ? "数据库不匹配！检查数据库是否属于当前帐号"
          : (error?.serverMsg || error?.message || "网络或包结构解析失败"),
      };
    }
  };
}
