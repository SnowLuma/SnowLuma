// GroupAlbumApi — group photo album operations (list/upload/comment/
// like/delete + media listing). Inlined from `actions/group-album.ts`
// and `web-actions/group-album.ts` (both deleted alongside actions/*
// in commit 13). The pure-HTTP helpers in `web/group-album.ts` stay
// where they are — they're transport-layer code, not Bridge actions.

import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  DeleteMediasRequest,
  DeleteMediasResponse,
  DoQunCommentRequest,
  DoQunCommentResponse,
  DoQunLikeRequest,
  DoQunLikeResponse,
  GetMediaListRequest,
  GetMediaListResponse,
} from '@snowluma/proto-defs/oidb-actions/group-album';
import type { BridgeContext } from '../bridge-context';
import type { Bridge } from '../bridge';
import { getGroupAlbumList, uploadImageToGroupAlbum } from '@snowluma/bridge/web/group-album';
// `getCookies` is part of WebApi — go through the hub so we don't
// duplicate the cookie acquisition flow.

function asBridge(ctx: BridgeContext): Bridge { return ctx as unknown as Bridge; }

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

export class GroupAlbumApi {
  constructor(private readonly ctx: BridgeContext) {}

  /** List a group's albums (HTTP-cookie-based, qzone.qq.com). */
  async list(groupId: number): Promise<any> {
    const groupCode = groupId.toString();
    const uin = this.ctx.identity.uin;
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    const albumData = await getGroupAlbumList(cookieObject, groupCode, uin);
    return albumData?.album || [];
  }

  /** Upload an image into an existing album (HTTP slice-upload). */
  async upload(groupId: number, albumId: string, albumName: string, filePath: string): Promise<void> {
    const groupCode = groupId.toString();
    const uin = this.ctx.identity.uin;
    const cookieObject = await this.ctx.apis.web.getCookies('qzone.qq.com');
    await uploadImageToGroupAlbum(cookieObject, groupCode, albumId, albumName, filePath, uin);
  }

  async getMediaList(groupId: number, albumId: string, attachInfo = ''): Promise<GroupAlbumMediaResult> {
    const traceId = `_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    const body = protobuf_encode<GetMediaListRequest>({
      field1: 0,
      field2: new Uint8Array(0),
      field3: new Uint8Array(0),
      reqInfo: {
        groupId: groupId.toString(),
        albumId,
        field3: 0,
        attachInfo,
        field5: '',
      },
      traceId,
      extMap: [{ key: 'fc-appid', value: '100' }],
    });

    const result = await this.ctx.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetMediaList',
      body,
      15000,
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

    return convertBigIntToString({ mediaList, nextAttachInfo });
  }

  async comment(groupId: number, albumId: string, lloc: string, content: string): Promise<GroupAlbumCommentResult> {
    const traceId = `_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const clientKey = Date.now().toString();
    const uin = this.ctx.identity.uin;

    const body = protobuf_encode<DoQunCommentRequest>({
      field1: 8527,
      field2: new Uint8Array(0),
      field3: new Uint8Array(0),
      body: {
        groupId: groupId.toString(),
        field3: 2,
        reqBody: {
          field1: { field3: 0, field4: '' },
          field2: {
            field1: { uin },
          },
          field5: {
            field1: {
              field2: {
                field1: 0, field2: '',
                lloc,
                field4: '', field6: '', field7: 0, field8: 0, field9: 0, field14: 0, field15: 0, field17: 0,
              },
            },
            albumId,
            field5: 0,
          },
        },
        field5: {
          field2: { uin },
          field3: {
            field1: 0,
            field2: content,
            field3: '', field4: '', field5: 0, field6: '',
          },
          clientKey,
        },
      },
      traceId,
      extMap: [{ key: 'fc-appid', value: '100' }],
    });

    const result = await this.ctx.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunComment',
      body,
      15000,
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

  async like(groupId: number, albumId: string, batchId: string, lloc: string | undefined, isLike: boolean): Promise<any> {
    const uin = this.ctx.identity.uin;
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
      field2: 'h5_test',
      field3: 'h5_test',
      body: {
        type,
        like: { id, status },
        publish: {
          cellCommon: {
            time: BigInt(Date.now()),
            feedId: `422_0_${batchId}`,
          },
          cellUserInfo: {
            user: { uin },
          },
          cellMedia: {
            albumId,
            batchId: BigInt(batchId),
          },
          cellQunInfo: {
            qunId: groupId.toString(),
          },
        },
        clientKey,
      },
      extMap: [{ key: 'fc-appid', value: '100' }],
    });

    const result = await this.ctx.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_operation.FeedsWriter.DoQunLike',
      body,
      15000,
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

  async delete(groupId: number, albumId: string, lloc: string): Promise<any> {
    const uin = this.ctx.identity.uin;
    const clientKey = `${uin}_${Date.now()}_${Math.floor(Math.random() * 100000)}`;

    const body = protobuf_encode<DeleteMediasRequest>({
      field1: 8694,
      field2: 'h5_test',
      field3: 'h5_test',
      body: {
        groupId: groupId.toString(),
        albumId,
        lloc,
      },
      traceId: clientKey,
      extMap: [{ key: 'fc-appid', value: '100' }],
    });

    const result = await this.ctx.sendRawPacket(
      'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.DeleteMedias',
      body,
      15000,
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
}
