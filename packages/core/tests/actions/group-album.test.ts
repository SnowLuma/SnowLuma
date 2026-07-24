import { describe, expect, it } from 'vitest';
import type {
  GetAlbumListResponse,
  GetMediaListResponse,
} from '@snowluma/proto-defs/oidb-actions/group-album';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { GroupAlbumApi } from '../../src/bridge/apis/group-album';
import { mockBridge } from './_helpers';
import type {
  GroupAlbumListRequestWireOracle,
  GroupAlbumListResponseWireOracle,
  GroupAlbumMediaListRequestWireOracle,
  GroupAlbumMediaListResponseWireOracle,
} from './group-album-wire-fixture';

function albumListResponseWithCover(): Uint8Array {
  return protobuf_encode<GroupAlbumListResponseWireOracle>({
    data: {
      albumList: [{
        albumId: 'album-id',
        owner: '10001',
        name: '测试相册',
        description: 'desc',
        createTime: 1700000000n,
        lastUploadTime: 1700000123n,
        uploadNumber: 5n,
        cover: {
          type: 1,
          image: {
            name: 'cover.jpg',
            sloc: 'small-location',
            lloc: 'large-location',
            photoUrls: [{
              spec: 3,
              url: { url: 'https://example.test/cover-320.jpg', width: 320, height: 180 },
            }],
            defaultUrl: { url: 'https://example.test/cover.jpg', width: 1280, height: 720 },
            isGif: false,
            hasRaw: true,
          },
        },
      }],
    },
  });
}

describe('apis/group-album', () => {
  it('uses QQ NT AlbumService and puts the pagination cursor in request body field 2', async () => {
    const bridge = mockBridge();
    const cursor = '{"IndexType":"next"}';

    await new GroupAlbumApi(bridge as never).listQun(12345, cursor);

    const [serviceCmd, requestBytes, timeoutMs] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('QunAlbum.trpc.qzone.webapp_qun_media.QunMedia.GetAlbumList');
    expect(timeoutMs).toBe(15000);

    const request = protobuf_decode<GroupAlbumListRequestWireOracle>(requestBytes);
    expect(request.seq).toBe(3331);
    expect(request.data).toEqual({ groupId: '12345', cursor });
    expect(request.extMap).toEqual([{ key: 'fc-appid', value: '100' }]);
    // QQ NT's codec writes the two empty common-envelope byte fields rather
    // than omitting them: field1=3331, field2="", field3="".
    expect(Buffer.from(requestBytes).subarray(0, 7).toString('hex'))
      .toBe('08831a12001a00');
  });

  it('preserves Unicode emoji and literal QQ-em tags in the legacy creator nickname', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GetAlbumListResponse>({
        seq: 3331,
        data: {
          albumList: [{
            albumId: 'album-id',
            owner: '10001',
            name: '测试相册',
            description: 'desc',
            createTime: 1700000000n,
            uploadNumber: 5n,
            creator: {
              uid: 'u_creator',
              uin: '10001',
              nick: '😂[em]e328514[/em]',
            },
          }],
        },
      })),
    });

    const result = await new GroupAlbumApi(bridge as never).list(12345);

    expect(result).toEqual([{
      id: 'album-id',
      name: '测试相册',
      picNum: 5,
      createTime: 1700000000,
      desc: 'desc',
      owner: '10001',
      createuin: '10001',
      createnickname: '😂[em]e328514[/em]',
      last_upload_time: 0,
      cover: null,
    }]);
  });

  it('fetches every AlbumService page for the legacy album list action', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket
      .mockResolvedValueOnce({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<GetAlbumListResponse>({
          data: {
            albumList: [{
              albumId: 'album-1',
              name: '第一页',
              createTime: 1n,
              uploadNumber: 1n,
            }],
            attachInfo: 'next-cursor',
            hasMore: true,
          },
        })),
      })
      .mockResolvedValueOnce({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<GetAlbumListResponse>({
          data: {
            albumList: [{
              albumId: 'album-2',
              name: '第二页',
              createTime: 2n,
              uploadNumber: 2n,
            }],
            hasMore: false,
          },
        })),
      });

    const result = await new GroupAlbumApi(bridge as never).list(12345);

    expect(result.map((album) => album.id)).toEqual(['album-1', 'album-2']);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
    const secondRequest = protobuf_decode<GroupAlbumListRequestWireOracle>(
      bridge.sendRawPacket.mock.calls[1]![1],
    );
    expect(secondRequest.data?.cursor).toBe('next-cursor');
  });

  it('rejects a legacy album page that claims more data without a cursor', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GetAlbumListResponse>({
        data: {
          albumList: [],
          hasMore: true,
        },
      })),
    });

    await expect(new GroupAlbumApi(bridge as never).list(12345))
      .rejects.toThrow('hasMore=true but cursor is empty');
  });

  it('rejects a repeated AlbumService cursor instead of looping or truncating', async () => {
    const bridge = mockBridge();
    const repeatedPage = {
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GetAlbumListResponse>({
        data: {
          albumList: [],
          attachInfo: 'same-cursor',
          hasMore: true,
        },
      })),
    };
    bridge.sendRawPacket
      .mockResolvedValueOnce(repeatedPage)
      .mockResolvedValueOnce(repeatedPage);

    await expect(new GroupAlbumApi(bridge as never).list(12345))
      .rejects.toThrow('repeated cursor at page 2');
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
  });

  it('returns the native AlbumService cursor and creator fields for get_qun_album_list', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GetAlbumListResponse>({
        data: {
          albumList: [{
            albumId: 'album-id',
            name: '测试相册',
            createTime: 1700000000n,
            uploadNumber: 5n,
            creator: { uin: '10001', nick: '😂' },
          }],
          attachInfo: 'next-cursor',
          hasMore: true,
        },
      })),
    });

    const result = await new GroupAlbumApi(bridge as never).listQun(12345);

    expect(result.attachInfo).toBe('next-cursor');
    expect(result.hasMore).toBe(true);
    expect(result.albumList[0]).toMatchObject({
      album_id: 'album-id',
      name: '测试相册',
      create_time: '1700000000',
      upload_number: '5',
      creator: { uin: '10001', nick: '😂' },
    });
  });

  it('decodes the native album cover field for get_qun_album_list', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(albumListResponseWithCover()),
    });

    const result = await new GroupAlbumApi(bridge as never).listQun(12345);

    expect(result.albumList[0]).toMatchObject({
      album_id: 'album-id',
      last_upload_time: '1700000123',
      cover: {
        type: 1,
        image: {
          name: 'cover.jpg',
          sloc: 'small-location',
          lloc: 'large-location',
          photoUrls: [{
            spec: 3,
            url: { url: 'https://example.test/cover-320.jpg', width: 320, height: 180 },
          }],
          defaultUrl: { url: 'https://example.test/cover.jpg', width: 1280, height: 720 },
          isGif: false,
          hasRaw: true,
        },
      },
    });
  });

  it('returns cover and last-upload metadata from the legacy album list action', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(albumListResponseWithCover()),
    });

    const result = await new GroupAlbumApi(bridge as never).list(12345);

    expect(result[0]).toMatchObject({
      id: 'album-id',
      last_upload_time: 1700000123,
      cover: {
        type: 1,
        image: {
          name: 'cover.jpg',
          defaultUrl: { url: 'https://example.test/cover.jpg', width: 1280, height: 720 },
        },
      },
    });
  });

  it('surfaces AlbumService response errors instead of falling back to the lossy web endpoint', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GetAlbumListResponse>({
        seq: 3331,
        result: 1001,
        errorText: 'permission denied',
      })),
    });

    await expect(new GroupAlbumApi(bridge as never).list(12345))
      .rejects.toThrow('result=1001, error=permission denied');
  });

  it('encodes the next-page cursor in the page-info field', async () => {
    const bridge = mockBridge();
    const cursor = '{"IndexType":"next","Loc":{"batch_id":2147483650}}';

    await new GroupAlbumApi(bridge as never).getMediaList(12345, 'album-id', cursor);

    const [, requestBytes] = bridge.sendRawPacket.mock.calls[0]!;
    const request = protobuf_decode<GroupAlbumMediaListRequestWireOracle>(requestBytes);
    expect(request.reqInfo?.pageInfo).toBe(cursor);
    expect(request.reqInfo?.reserved).toBeNull();
  });

  it('accepts a successful media-list response with an omitted zero retCode', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GetMediaListResponse>({
        data: {
          mediaList: [{
            type: 1,
            uploader: '10001',
            batchId: 123n,
            uploadTime: 456n,
          }],
          nextAttachInfo: 'next-page',
        },
      })),
    });

    const result = await new GroupAlbumApi(bridge as never).getMediaList(12345, 'album-id');

    expect(result).toEqual({
      mediaList: [{
        type: 1,
        image: null,
        video: null,
        uploader: '10001',
        batchId: '123',
        uploadTime: '456',
      }],
      nextAttachInfo: 'next-page',
    });
  });

  it('returns video metadata from the group album media list', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true,
      gotResponse: true,
      errorCode: 0,
      errorMessage: '',
      responseData: Buffer.from(protobuf_encode<GroupAlbumMediaListResponseWireOracle>({
        data: {
          mediaList: [{
            type: 2,
            video: {
              id: 'video-id',
              url: 'https://example.test/video.mp4',
              cover: {
                name: 'cover.jpg',
                sloc: 'cover-small',
                lloc: 'cover-large',
                photoUrls: [{
                  spec: 3,
                  url: { url: 'https://example.test/cover-320.jpg', width: 320, height: 180 },
                }],
                defaultUrl: { url: 'https://example.test/cover.jpg', width: 1920, height: 1080 },
                isGif: true,
                hasRaw: true,
              },
              width: 1920,
              height: 1080,
              videoTime: 15n,
              videoUrl: [{
                spec: 1,
                url: { url: 'https://example.test/video-720p.mp4', width: 1280, height: 720 },
              }],
            },
            uploader: '10001',
            batchId: 123n,
            uploadTime: 456n,
          }],
          nextAttachInfo: 'next-video-page',
        },
      })),
    });

    const result = await new GroupAlbumApi(bridge as never).getMediaList(12345, 'album-id');

    expect(result).toEqual({
      mediaList: [{
        type: 2,
        image: null,
        video: {
          id: 'video-id',
          url: 'https://example.test/video.mp4',
          cover: {
            name: 'cover.jpg',
            sloc: 'cover-small',
            lloc: 'cover-large',
            photoUrls: [{
              spec: 3,
              url: { url: 'https://example.test/cover-320.jpg', width: 320, height: 180 },
            }],
            defaultUrl: { url: 'https://example.test/cover.jpg', width: 1920, height: 1080 },
            isGif: true,
            hasRaw: true,
          },
          width: 1920,
          height: 1080,
          videoTime: '15',
          videoUrl: [{
            spec: 1,
            url: { url: 'https://example.test/video-720p.mp4', width: 1280, height: 720 },
          }],
        },
        uploader: '10001',
        batchId: '123',
        uploadTime: '456',
      }],
      nextAttachInfo: 'next-video-page',
    });
  });
});
