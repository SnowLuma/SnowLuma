// 0x6D8_1 — ONE page of the group-file listing under `targetDirectory`.
// Paginated; the facade loops this until `isEnd=true` or the page cap
// is hit. Each page yields a mix of files (`type=1`) and folders
// (`type=2`); the caller flattens them.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  OidbGroupFileListItemResp,
  OidbGroupFileViewReq,
  OidbGroupFileViewResp,
} from '@snowluma/proto-defs/oidb-actions/group-file';
import { invokeOidb, type OidbSender } from '../../oidb-service';
import { ensureRetCodeZero } from '../shared';

export interface GroupFileListPage {
  items: OidbGroupFileListItemResp[];
  isEnd: boolean;
}

export namespace ListGroupFilesPage {
  export const command = 0x6D8;
  export const subCommand = 1;
  export const uinForm = true;

  export interface Params {
    groupId: number;
    targetDirectory: string;
    startIndex: number;
    pageSize: number;
  }

  export type Deps = OidbSender;

  export const serialize = (_ctx: Deps, p: Params): OidbGroupFileViewReq => ({
    list: {
      groupUin: p.groupId,
      appId: 7,
      targetDirectory: p.targetDirectory,
      fileCount: p.pageSize,
      sortBy: 1,
      startIndex: p.startIndex,
      field17: 2,
      field18: 0,
    },
  });

  /** Returns items + isEnd after checking list.retCode. Returns null when
   *  the server elides the list entirely (end-of-stream sentinel). */
  export const deserialize = (_ctx: Deps, body: OidbGroupFileViewResp): GroupFileListPage | null => {
    const list = body.list;
    if (!list) return null;
    ensureRetCodeZero('group file list', list.retCode, list.retMsg, list.clientWording);
    return { items: list.items ?? [], isEnd: !!list.isEnd };
  };

  export const encode = (env: OidbBase<OidbGroupFileViewReq>): Uint8Array =>
    protobuf_encode<OidbBase<OidbGroupFileViewReq>>(env);

  export const decode = (bytes: Uint8Array): OidbBase<OidbGroupFileViewResp> =>
    protobuf_decode<OidbBase<OidbGroupFileViewResp>>(bytes);

  export const invoke = (deps: Deps, params: Params): Promise<GroupFileListPage | null> =>
    invokeOidb(deps, ListGroupFilesPage, params);
}
