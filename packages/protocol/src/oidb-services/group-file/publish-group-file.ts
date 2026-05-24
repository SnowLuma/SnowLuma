// 0x6D9_4 — publish a previously-uploaded group file as a chat
// message (the file-bubble in the group transcript).
//
// The QQ-NT server rejects the legacy `TransElem(elemType=24)` payload
// on outgoing send (`result=79`) so the file-publish path goes via a
// dedicated OIDB hop instead of `MessageSvc.PbSendMsg`. Mirror
// Lagrange.Core V2's `GroupSendFileService.cs`:
//   - `info.field3` is a 31-bit random — Lagrange does `Random.Shared.Next()`
//   - `info.field5 = true` is the discriminator the server's deserializer
//     expects to recognise this branch.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase, OidbEmpty } from '@snowluma/proto-defs/oidb';
import type { OidbGroupSendFileReq } from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';

export namespace PublishGroupFile {
  export const command = 0x6D9;
  export const subCommand = 4;

  export interface Params { groupId: number; fileId: string; }
  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupSendFileReq => ({
    body: {
      groupUin: p.groupId,
      type: 2,
      info: {
        busiType: 102,
        fileId: p.fileId,
        field3: Math.floor(Math.random() * 0x7fffffff) >>> 0,
        field5: true,
      },
    },
  });

  export const deserialize = (_ctx: Deps, _: OidbEmpty): void => {};

  export const encode = (env: OidbBase<OidbGroupSendFileReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupSendFileReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbEmpty> =>
    protobuf_decode<OidbBase<OidbEmpty>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<void> =>
    invokeOidb(deps, PublishGroupFile, params);
}
