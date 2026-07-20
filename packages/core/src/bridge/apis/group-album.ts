import type { JsonObject, JsonValue } from '@snowluma/common/json';
import { createLogger } from '@snowluma/common/logger';
import type {
  AlbumCreator,
  DeleteMediasRequest,
  DeleteMediasResponse,
  DoQunCommentRequest,
  DoQunCommentResponse,
  DoQunLikeRequest,
  DoQunLikeResponse,
  GetAlbumListRequest,
  GetAlbumListResponse,
  GroupAlbumInfo as GroupAlbumInfoWire,
  GetMediaListRequest,
  GetMediaListResponse,
  MediaInfo,
} from '@snowluma/proto-defs/oidb-actions/group-album';
import { uploadImageToGroupAlbum } from '@snowluma/protocol/web/group-album';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { BridgeContext } from '../bridge-context';

const log = createLogger('Bridge.GroupAlbum');
const GET_ALBUM_LIST_CMD = 'QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetAlbumList';
const GET_ALBUM_LIST_SEQ = 3331;

function uint64ToString(value: bigint | undefined): string {
  return (value ?? 0n).toString();
}

function uint64ToSafeNumber(value: bigint | undefined, fieldName: string): number {
  const normalized = value ?? 0n;
  if (normalized > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new Error(`group album ${fieldName} exceeds Number.MAX_SAFE_INTEGER: ${normalized}`);
  }
  return Number(normalized);
}

function normalizeAlbumCreator(creator: AlbumCreator | undefined): QunAlbumCreator | undefined {
  if (!creator) return undefined;
  return {
    uid: creator.uid ?? '',
    nick: creator.nick ?? '',
    is_sweet: creator.isSweet ?? false,
    is_special: creator.isSpecial ?? false,
    is_super_like: creator.isSuperLike ?? false,
    custom_id: creator.customId ?? '',
    poly_id: creator.polyId ?? '',
    portrait: creator.portrait ?? '',
    can_follow: creator.canFollow ?? 0,
    isfollowed: creator.isFollowed ?? 0,
    uin: creator.uin ?? '',
    ditto_uin: creator.dittoUin ?? '',
  };
}

function normalizeQunAlbum(album: GroupAlbumInfoWire): QunAlbumInfo {
  const normalized: QunAlbumInfo = {
    album_id: album.albumId ?? '',
    owner: album.owner ?? '',
    name: album.name ?? '',
    desc: album.description ?? '',
    create_time: uint64ToString(album.createTime),
    modify_time: uint64ToString(album.modifyTime),
    last_upload_time: uint64ToString(album.lastUploadTime),
    upload_number: uint64ToString(album.uploadNumber),
    top_flag: uint64ToString(album.topFlag),
    busi_type: album.busiType ?? 0,
    status: album.status ?? 0,
    allow_share: album.allowShare ?? false,
    is_subscribe: album.isSubscribe ?? false,
    bitmap: album.bitmap ?? '',
    is_share_album: album.isShareAlbum ?? false,
    qz_album_type: album.qzAlbumType ?? 0,
    cover_type: album.coverType ?? 0,
    default_desc: album.defaultDesc ?? '',
    sort_type: album.sortType ?? 0,
  };
  const creator = normalizeAlbumCreator(album.creator);
  if (creator) normalized.creator = creator;
  return normalized;
}

function toLegacyAlbum(album: GroupAlbumInfoWire): GroupAlbumInfo {
  const creator = normalizeAlbumCreator(album.creator);
  return {
    id: album.albumId ?? '',
    name: album.name ?? '',
    picNum: uint64ToSafeNumber(album.uploadNumber, 'upload_number'),
    createTime: uint64ToSafeNumber(album.createTime, 'create_time'),
    desc: album.description ?? '',
    owner: album.owner ?? '',
    createuin: creator?.uin || album.owner || creator?.uid || '',
    // QQ NT's AlbumService returns this as a normal UTF-8 protobuf string.
    // Unlike the legacy Qzone HTTP endpoint, it does not rewrite Unicode
    // emoji into ambiguous [em]...[/em] tags.
    createnickname: creator?.nick ?? '',
  };
}

function convertBigIntToString(obj: unknown): JsonValue {
  if (obj === null || obj === undefined) return null;
  if (typeof obj === 'bigint') return obj.toString();
  if (Array.isArray(obj)) return obj.map(convertBigIntToString);
  if (typeof obj === 'object') {
    const result: JsonObject = {};
    for (const [key, value] of Object.entries(obj)) {
      result[key] = convertBigIntToString(value);
    }
    return result;
  }
  if (typeof obj === 'string' || typeof obj === 'number' || typeof obj === 'boolean') return obj;
  return null;
}

export class GroupAlbumApi {
  constructor(private readonly ctx: BridgeContext) { }

  private async fetchAlbumList(groupId: number, attachInfo: string): Promise<GroupAlbumWireResult> {
    const traceId = `_${Date.now()}_${Math.floor(Math.random() * 100000)}`;
    const body = protobuf_encode<GetAlbumListRequest>({
      seq: GET_ALBUM_LIST_SEQ,
      field2: new Uint8Array(0),
      field3: new Uint8Array(0),
      data: {
        groupId: groupId.toString(),
        attachInfo,
      },
      traceId,
      extMap: [{ key: 'fc-appid', value: '100' }],
    });

    log.debug(
      'get album list request: group=%d cursorChars=%d requestBytes=%d',
      groupId,
      attachInfo.length,
      body.length,
    );

    const result = await this.ctx.sendRawPacket(GET_ALBUM_LIST_CMD, body, 15000);
    if (!result.success || !result.gotResponse || !result.responseData) {
      throw new Error(
        `get group album list transport failed: ${result.errorMessage || `code ${result.errorCode}`}`,
      );
    }

    const response = protobuf_decode<GetAlbumListResponse>(result.responseData);
    const resultCode = response.result ?? 0;
    if (resultCode !== 0) {
      throw new Error(
        `get group album list failed: result=${resultCode}, error=${response.errorText || 'unknown'}`,
      );
    }

    const normalized: GroupAlbumWireResult = {
      albumList: response.data?.albumList ?? [],
      attachInfo: response.data?.attachInfo ?? '',
      hasMore: response.data?.hasMore ?? false,
    };

    log.debug(
      'get album list response: group=%d albums=%d hasMore=%s cursorChars=%d responseBytes=%d',
      groupId,
      normalized.albumList.length,
      String(normalized.hasMore),
      normalized.attachInfo.length,
      result.responseData.length,
    );
    return normalized;
  }

  /** QQ NT AlbumService-backed list, including its pagination cursor. */
  async listQun(groupId: number, attachInfo = ''): Promise<QunAlbumListResult> {
    const result = await this.fetchAlbumList(groupId, attachInfo);
    return {
      albumList: result.albumList.map(normalizeQunAlbum),
      attachInfo: result.attachInfo,
      hasMore: result.hasMore,
    };
  }

  // OneBot compatibility shape used by get_group_album_list.
  async list(groupId: number): Promise<GroupAlbumList> {
    const result = await this.fetchAlbumList(groupId, '');
    return result.albumList.map(toLegacyAlbum);
  }

  // 上传图片到现有相册（HTTP 分片上传）。
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
        field4: '',
        pageInfo: attachInfo,
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

    const retCode = resp.field1 ?? 0;
    if (retCode !== 0) {
      throw new Error(`fetch album media list error: retCode ${retCode}`);
    }

    const data = resp.data ?? {};
    const mediaList = data.mediaList ?? [];
    const nextAttachInfo = data.nextAttachInfo ?? '';

    return convertBigIntToString({ mediaList, nextAttachInfo }) as unknown as GroupAlbumMediaResult;
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
    }) as unknown as GroupAlbumCommentResult;
  }

  async like(groupId: number, albumId: string, batchId: string, lloc: string | undefined, isLike: boolean): Promise<JsonValue> {
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

  async delete(groupId: number, albumId: string, lloc: string): Promise<{ success: true }> {
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
export interface GroupAlbumMediaResult {
  mediaList: Array<JsonValue & Partial<MediaInfo>>;
  nextAttachInfo: string;
}

interface GroupAlbumWireResult {
  albumList: GroupAlbumInfoWire[];
  attachInfo: string;
  hasMore: boolean;
}

export interface GroupAlbumInfo {
  id: string;
  name: string;
  picNum: number;
  createTime: number;
  desc: string;
  owner: string;
  createuin: string;
  createnickname: string;
  [key: string]: JsonValue;
}

export type GroupAlbumList = GroupAlbumInfo[];

export interface QunAlbumCreator {
  uid: string;
  nick: string;
  is_sweet: boolean;
  is_special: boolean;
  is_super_like: boolean;
  custom_id: string;
  poly_id: string;
  portrait: string;
  can_follow: number;
  isfollowed: number;
  uin: string;
  ditto_uin: string;
}

export interface QunAlbumInfo {
  album_id: string;
  owner: string;
  name: string;
  desc: string;
  create_time: string;
  modify_time: string;
  last_upload_time: string;
  upload_number: string;
  creator?: QunAlbumCreator;
  top_flag: string;
  busi_type: number;
  status: number;
  allow_share: boolean;
  is_subscribe: boolean;
  bitmap: string;
  is_share_album: boolean;
  qz_album_type: number;
  cover_type: number;
  default_desc: string;
  sort_type: number;
}

export interface QunAlbumListResult {
  albumList: QunAlbumInfo[];
  attachInfo: string;
  hasMore: boolean;
}

export interface GroupAlbumCommentResult {
  id: string;
  user: { uin: string };
  content: Array<{ type: number; content: string }>;
  time: string;
  clientKey: string;
}
