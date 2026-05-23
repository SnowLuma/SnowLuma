// 0xFE1_2 — fetch a user's profile (nickname / qid / sex / age / sign
// / avatar / QQ level).
//
// `uinForm` is set so the server takes the UIN-form validation path;
// without it newer NTQQ versions reject the request with
// `[oidb] one of uid/openid is invaild`. Matches Lagrange.Core's
// FetchStrangerByUin (Reserved = 1).
//
// Property key catalogue (cross-checked against LagrangeV2's
// FetchStrangerService.cs):
//   101   — avatar info (proto-encoded AvatarInfo)
//   102   — sign (signature)
//   103   — remark
//   105   — QQ level (numeric)
//   20002 — nickname
//   20009 — gender (1 male / 2 female / 255 unknown)
//   20037 — age
//   27394 — QID

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  AvatarInfo,
  OidbUserInfoRequest,
  OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { UserProfileInfo } from '../../qq-info';
import { invokeOidb, type OidbSender } from '../../oidb-service';

const REQUESTED_KEYS = [
  20002, 27394, 20009, 20031, 101, 103, 102, 20020, 20003, 20026,
  105, 27372, 27406, 20037,
];

export namespace FetchUserProfile {
  export const command = 0xFE1;
  export const subCommand = 2;
  export const uinForm = true;

  export interface Params {
    uin: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbUserInfoRequest => ({
    uin: p.uin,
    keys: REQUESTED_KEYS.map(k => ({ key: k })),
  });

  /** Defaults the response uin to `requestedUin` because the server
   *  sometimes elides its echo. `invoke` below binds `params.uin` via
   *  the spec override so the namespace's call surface still takes
   *  only `(ctx, body)`. */
  export const deserializeWithFallback = (
    body: OidbUserInfoResponse, requestedUin: number,
  ): UserProfileInfo => {
    if (!body.body) throw new Error('user info response body missing');

    const info: UserProfileInfo = {
      uin: body.body.uin ?? requestedUin,
      uid: body.body.uid ?? '',
      nickname: '', remark: '', qid: '', sex: 'unknown', age: 0, sign: '', avatar: '', level: 0,
    };

    if (body.body.properties) {
      const bytesMap = new Map<number, Uint8Array>();
      const numMap = new Map<number, number>();
      for (const bp of body.body.properties.bytesProperties ?? []) {
        bytesMap.set(bp.code ?? 0, bp.value ?? new Uint8Array(0));
      }
      for (const np of body.body.properties.numberProperties ?? []) {
        numMap.set(np.number1 ?? 0, np.number2 ?? 0);
      }
      const getString = (code: number): string => {
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
      info.level = numMap.get(105) ?? 0;
    }

    return info;
  };

  // Default deserialize uses uin=0 fallback — invoke() rewires it to
  // the requested uin via the per-call spec override below. Tests
  // that call deserialize directly should use deserializeWithFallback.
  export const deserialize = (_ctx: Deps, body: OidbUserInfoResponse): UserProfileInfo =>
    deserializeWithFallback(body, 0);

  export const encode = (env: OidbBase<OidbUserInfoRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbUserInfoRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbUserInfoResponse> =>
    protobuf_decode<OidbBase<OidbUserInfoResponse>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<UserProfileInfo> =>
    invokeOidb(deps, {
      ...FetchUserProfile,
      deserialize: (_ctx, body) => deserializeWithFallback(body, params.uin),
    }, params);
}
