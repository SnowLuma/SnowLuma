// 0xFE1_2 (UID form) — fetch a user's profile when only the UID is
// known. Same OIDB cmd + subcmd as `FetchUserProfile` (by UIN) but
// the request body's field 1 is `uid: string` instead of `uin:
// uint32`, and `reserved` stays 0 (no `uinForm`).
//
// Why two namespaces for the same (cmd, subcmd):
//   - Group join requests / invitations carry the stranger's UID
//     only — we never get a UIN for someone who hasn't joined yet.
//   - The Tencent server WILL reject a UIN-form request with a uid-
//     shaped value or vice versa, so the two variants must encode
//     to byte-different wires.
//   - Matches Lagrange's `OidbSvcTrpcTcp0xFE1_2Uid` vs `…Uin` split
//     at `dev/Lagrange.Core/.../OidbSvcTrpcTcp0xFE1_2.cs:9-26`
//     and the dispatch at
//     `dev/Lagrange.Core/.../FetchUserInfoService.cs:66-78`.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  AvatarInfo,
  OidbUserInfoByUidRequest,
  OidbUserInfoResponse,
} from '@snowluma/proto-defs/oidb-actions/base';
import type { UserProfileInfo } from '../../qq-info';
import { invokeOidb, type OidbSender } from '../../oidb-service';

const REQUESTED_KEYS = [
  20002, 27394, 20009, 20031, 101, 103, 102, 20020, 20003, 20026,
  105, 27372, 27406, 20037,
];

export namespace FetchUserProfileByUid {
  export const command = 0xFE1;
  export const subCommand = 2;
  // No `uinForm` — the UID variant uses the default `reserved=0`
  // envelope, mirroring Lagrange's untagged constructor at
  // `OidbSvcTrpcTcp0xFE1_2.cs:9` (isUid=false → Reserved=0).

  export interface Params {
    uid: string;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbUserInfoByUidRequest => ({
    uid: p.uid,
    keys: REQUESTED_KEYS.map(k => ({ key: k })),
  });

  export const deserialize = (_ctx: Deps, body: OidbUserInfoResponse): UserProfileInfo => {
    if (!body.body) throw new Error('user info response body missing');

    const info: UserProfileInfo = {
      uin: body.body.uin ?? 0,
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

  export const encode = (env: OidbBase<OidbUserInfoByUidRequest>): Uint8Array =>
    protobuf_encode<OidbBase<OidbUserInfoByUidRequest>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbUserInfoResponse> =>
    protobuf_decode<OidbBase<OidbUserInfoResponse>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<UserProfileInfo> =>
    invokeOidb(deps, FetchUserProfileByUid, params);
}
