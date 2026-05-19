// Group album actions via TRPC protocol.
//
// Unlike the OIDB action family, these endpoints speak raw TRPC
// (service command `QunAlbum.trpc.qzone.webapp_qun_*`) without an
// `OidbBase<T>` envelope. We hit `bridge.sendRawPacket` directly with
// proton-encoded bodies and decode the responses through proton's
// monomorphized codecs.

import type { Bridge } from '../bridge';
import { protobuf_encode, protobuf_decode } from '@snowluma/proton';
import type {
  GetMediaListRequest,
  GetMediaListResponse,
  DoQunCommentRequest,
  DoQunCommentResponse,
  DoQunLikeRequest,
  DoQunLikeResponse,
  DeleteMediasRequest,
  DeleteMediasResponse,
} from '../proto/proton/oidb-action';

export interface GroupAlbumMediaResult {
  mediaList: any[];
  nextAttachInfo: string;
}

export interface GroupAlbumCommentResult {
  id: string;
  user: { uin: string };
  content: Array<{ type: number; content: string }>;
  time: string;
  clientKey: string;
}

function convertBigIntToString(obj: any): any {
  if (obj === null || obj === undefined) return obj;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(convertBigIntToString);
  if (typeof obj === 'object') {
    const result: any = {};
    for (const key in obj) {
      result[key] = convertBigIntToString(obj[key]);
    }
    return result;
  }
  return obj;
}

export async function getGroupAlbumMediaList(
    bridge: Bridge,
    groupId: number,
    albumId: string,
    attachInfo: string = ''
): Promise<GroupAlbumMediaResult> {
  const traceId = `_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const body = protobuf_encode<GetMediaListRequest>({
    field1: 0,
    field2: new Uint8Array(0),
    field3: new Uint8Array(0),
    reqInfo: {
      groupId: groupId.toString(),
      albumId: albumId,
      field3: 0,
      attachInfo: attachInfo,
      field5: '',
    },
    traceId: traceId,
    extMap: [{ key: 'fc-appid', value: '100' }],
  });

  const result = await bridge.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList',
      body,
      15000
  );

  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'failed to get album media list');
  }

  const resp = protobuf_decode<GetMediaListResponse>(result.responseData);

  if (resp.field1 !== 0) {
    throw new Error(`fetch album media list error: retCode ${resp.field1 ?? 'unknown'}`);
  }

  const data = resp.data ?? {};
  const mediaList = data.mediaList ?? [];
  const nextAttachInfo = data.nextAttachInfo ?? '';

  return convertBigIntToString({
    mediaList,
    nextAttachInfo,
  });
}



export async function commentGroupAlbumMedia(
    bridge: Bridge,
    groupId: number,
    albumId: string,
    lloc: string,
    content: string
): Promise<GroupAlbumCommentResult> {
  const traceId = `_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
  const clientKey = Date.now().toString();
  const uin = bridge.identity.uin;

  const body = protobuf_encode<DoQunCommentRequest>({
    field1: 8527,
    field2: new Uint8Array(0),
    field3: new Uint8Array(0),
    body: {
      groupId: groupId.toString(),
      field3: 2,
      reqBody: {
        field1: { field3: 0, field4: "" },
        field2: {
          field1: { uin }
        },
        field5: {
          field1: {
            field2: {
              field1: 0, field2: "",
              lloc,
              field4: "", field6: "", field7: 0, field8: 0, field9: 0, field14: 0, field15: 0, field17: 0
            }
          },
          albumId,
          field5: 0
        },
      },
      field5: {
        field2: { uin },
        field3: {
          field1: 0,
          field2: content,
          field3: "", field4: "", field5: 0, field6: ""
        },
        clientKey,
      }
    },
    traceId,
    extMap: [{ key: 'fc-appid', value: '100' }],
  });

  const result = await bridge.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment',
      body,
      15000
  );

  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'failed to comment on album media');
  }

  const resp = protobuf_decode<DoQunCommentResponse>(result.responseData);

  const resCode = resp.field1;
  if (resCode !== 0 && resCode !== 8527 && !resp.comment) {
    throw new Error(`comment album media error: retCode ${resCode ?? 'unknown'}`);
  }

  const commentData = resp.comment?.data ?? {};

  return convertBigIntToString({
    id: commentData.id ?? '',
    user: { uin: commentData.user?.uin ?? '' },
    content: commentData.content ?? [],
    time: commentData.time ?? '0',
    clientKey: commentData.clientKey ?? '',
  });
}

export async function likeGroupAlbumMedia(
    bridge: Bridge,
    groupId: number,
    albumId: string,
    batchId: string,
    lloc: string | undefined,
    isLike: boolean
): Promise<any> {
  const uin = bridge.identity.uin;
  const clientKey = `${uin}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const type = isLike ? 2 : 1;
  const status = isLike ? 0 : 1;

  let id = '';
  if (lloc) {
    id = `421_1_0_${groupId}|${albumId}|${batchId}^||^421_1_0_${groupId}|${albumId}|${lloc}^||^0`;
  } else {
    id = `421_1_0_${groupId}|${albumId}|${batchId}`;
  }

  const body = protobuf_encode<DoQunLikeRequest>({
    field1: 5495,
    field2: "h5_test",
    field3: "h5_test",
    body: {
      type,
      like: { id, status },
      publish: {
        cellCommon: {
          time: BigInt(Date.now()),
          feedId: `422_0_${batchId}`
        },
        cellUserInfo: {
          user: { uin }
        },
        cellMedia: {
          albumId: albumId,
          batchId: BigInt(batchId)
        },
        cellQunInfo: {
          qunId: groupId.toString()
        }
      },
      clientKey
    },
    extMap: [{ key: 'fc-appid', value: '100' }],
  });

  const result = await bridge.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike',
      body,
      15000
  );

  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'failed to like album media');
  }

  const resp = protobuf_decode<DoQunLikeResponse>(result.responseData);
  const resCode = resp.field1;

  if (resCode !== 5495) {
    throw new Error(`like album media error: retCode ${resCode ?? 'unknown'}`);
  }

  return convertBigIntToString(resp.body?.like ?? {});
}

export async function deleteGroupAlbumMedia(
    bridge: Bridge,
    groupId: number,
    albumId: string,
    lloc: string
): Promise<any> {
  const uin = bridge.identity.uin;
  const clientKey = `${uin}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

  const body = protobuf_encode<DeleteMediasRequest>({
    field1: 8694,
    field2: "h5_test",
    field3: "h5_test",
    body: {
      groupId: groupId.toString(),
      albumId: albumId,
      lloc: lloc,
    },
    traceId: clientKey,
    extMap: [{ key: 'fc-appid', value: '100' }],
  });

  const result = await bridge.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias',
      body,
      15000
  );

  if (!result.success || !result.gotResponse || !result.responseData) {
    throw new Error(result.errorMessage || 'failed to delete album media');
  }

  const resp = protobuf_decode<DeleteMediasResponse>(result.responseData);
  const resCode = resp.field1;
  const errCode = resp.field2;
  const errMsg = resp.field3;

  if (resCode !== 8694 || errCode) {
    throw new Error(`delete album media error [${errCode ?? 'unknown'}]: ${errMsg ?? 'unknown'}`);
  }

  return { success: true };
}

