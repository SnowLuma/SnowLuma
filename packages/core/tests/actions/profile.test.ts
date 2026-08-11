import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  CustomFaceModifyResp,
  CustomFaceMoveBody,
  FaceroamOpResp,
  GroupAvatarExtra,
  Oidb0x7edResp,
  Oidb0xe17Resp,
  SetStatusReq,
  SetStatusResp,
} from '@snowluma/proto-defs/oidb-actions/base';

// `encodeOidbEnv` / `decodeOidbEnv` are proton-bound pass-through wrappers
// (substituted at the call site with the inlined codec). Mocking them on
// the module object is a no-op — proton has already inlined the call.
// We mock `runOidb` (non-generic) to return real proton-encoded bytes
// that the production-side codec actually decodes.
vi.mock('@snowluma/protocol/bridge-oidb', async () => {
  const actual = await vi.importActual<typeof import('@snowluma/protocol/bridge-oidb')>(
    '@snowluma/protocol/bridge-oidb',
  );
  return {
    ...actual,
    runOidb: vi.fn(async () => new Uint8Array()),
    makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  };
});

vi.mock('@snowluma/protocol/highway', () => ({
  fetchHighwaySession: vi.fn(async () => ({})),
  uploadHighwayHttp: vi.fn(async () => undefined),
  BufferChunkSource: class BufferChunkSource { constructor(readonly bytes: Uint8Array) {} },
}));

vi.mock('@snowluma/protocol/highway/utils', () => ({
  loadBinarySource: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), fileName: 'avatar.bin' })),
  computeHashes: vi.fn(() => ({ md5: new Uint8Array(16), sha1: new Uint8Array(20) })),
  computeMd5: vi.fn(() => new Uint8Array(16)),
}));

import * as oidb from '@snowluma/protocol/bridge-oidb';
import * as highwayClient from '@snowluma/protocol/highway';
import { ProfileApi } from '../../src/bridge/apis/profile';
import { mockBridge } from './_helpers';

describe('apis/profile', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
    vi.mocked(highwayClient.fetchHighwaySession).mockClear();
    vi.mocked(highwayClient.uploadHighwayHttp).mockClear();
  });

  it('setOnlineStatus sends to status_svc.SetStatus and accepts an empty response', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setOnlineStatus( 11, 0, 100);
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.qq_new_tech.status_svc.StatusService.SetStatus');
  });

  it('setOnlineStatus does NOT include the customExt field 4 (varint 0x22 absent in body)', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setOnlineStatus( 11, 0, 100);
    const [, body] = bridge.sendRawPacket.mock.calls[0]!;
    // proto field 4 length-delimited tag = (4 << 3) | 2 = 0x22. The
    // body should not contain that byte; if encoder ever leaks an
    // empty customExt it'd appear here.
    expect(Buffer.from(body).includes(0x22)).toBe(false);
  });

  it('setDiyOnlineStatus hardcodes status=10 / extStatus=2000 and packs faceId+wording+faceType into customExt', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setDiyOnlineStatus( 1234, '摸鱼中', 2);
    const [serviceCmd, body] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.qq_new_tech.status_svc.StatusService.SetStatus');
    // Decode the wire bytes back through the same schema to assert
    // every field landed in the right place.
    const decoded = protobuf_decode<SetStatusReq>(body as Uint8Array);
    expect(decoded).toMatchObject({
      status: 10,
      extStatus: 2000,
      customExt: { faceId: 1234, text: '摸鱼中', faceType: 2 },
    });
    expect(decoded.batteryStatus ?? 0).toBe(0);
  });

  it('setDiyOnlineStatus surfaces server errors via the same path as setOnlineStatus', async () => {
    const bridge = mockBridge();
    // Build a response that decodes to errCode != 0.
    const respBuf = Buffer.from(protobuf_encode<SetStatusResp>({ errCode: 1, errMsg: 'denied' }));
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: respBuf,
    } as any);
    await expect(new ProfileApi(bridge as any).setDiyOnlineStatus( 1, 't', 1)).rejects.toThrow(/denied/);
  });

  it('setDiyOnlineStatus rejects when the transport itself fails', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: false, gotResponse: false, errorCode: -1, errorMessage: 'pipe closed', responseData: null,
    } as any);
    await expect(new ProfileApi(bridge as any).setDiyOnlineStatus( 1, 't', 1)).rejects.toThrow(/pipe closed/);
  });

  it('setProfile is a no-op when both arguments are undefined', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setProfile();
    // Namespace migration: no SSO packet should fire at all.
    expect(bridge.sendRawPacket).not.toHaveBeenCalled();
  });

  it('setProfile only sends non-undefined fields', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setProfile('New Nick');
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x112a_2');
  });

  it('setSelfLongNick targets 0x112a_2 wire cmd', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setSelfLongNick( 'hello world');
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x112a_2');
  });

  it('setInputStatus resolves UID first and sends 0xcd4_1', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setInputStatus( 10001, 1);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xcd4_1');
  });

  it('setAvatar loads bytes and pushes through the highway upload path (cmd 90)', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setAvatar( '/some/avatar.png');
    expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    const [, , cmdId, , , extend] = vi.mocked(highwayClient.uploadHighwayHttp).mock.calls[0]!;
    expect(cmdId).toBe(90);
    expect((extend as Uint8Array).length).toBe(0); // personal avatar has no extra payload
  });

  it('setGroupAvatar uses cmdId 3000 and packs the Lagrange GroupAvatarExtra constants', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setGroupAvatar( 12345, '/some/group-avatar.png');
    expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    const [, , cmdId, , , extend] = vi.mocked(highwayClient.uploadHighwayHttp).mock.calls[0]!;
    expect(cmdId).toBe(3000);
    // Decode the extra blob back through the schema and assert every
    // protocol-prescribed constant lands where it should.
    const decoded = protobuf_decode<GroupAvatarExtra>(extend as Uint8Array);
    expect(decoded).toEqual({
      type: 101,
      groupUin: 12345,
      field3: { field1: 1 },
      field5: 3,
      field6: 1,
    });
  });

  it('setGroupAvatar rejects an empty file before hitting highway', async () => {
    const bridge = mockBridge();
    const { loadBinarySource } = await import('@snowluma/protocol/highway/utils');
    vi.mocked(loadBinarySource).mockResolvedValueOnce({
      bytes: new Uint8Array(0), fileName: 'empty.png',
    } as any);
    await expect(new ProfileApi(bridge as any).setGroupAvatar( 1, 'empty.png')).rejects.toThrow(/empty/);
    expect(highwayClient.fetchHighwaySession).not.toHaveBeenCalled();
  });

  it('getProfileLike (self): resolves self UID, returns formatted favorite + vote info', async () => {
    const bridge = mockBridge();
    bridge.identity.findUinByUid.mockImplementation(
      (uid: string) => uid === 'liker-uid' ? 20002 : 0,
    );
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({
        body: {
          userLikeInfos: [{
            uid: 'u',
            time: 1700000000,
            favoriteInfo: { totalCount: 5, lastTime: 1, todayCount: 1 },
            voteInfo: {
              totalCount: 7,
              newCount: 2,
              newNearbyCount: 1,
              lastVisitTime: 2,
              userInfos: [{ uid: 'liker-uid', nick: '点赞者', count: 3 }],
            },
          }],
        } as any,
      })),
    });
    const out = await new ProfileApi(bridge as any).getLike();
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x7ed_13');
    expect(out.favoriteInfo.total_count).toBe(5);
    expect(out.voteInfo.total_count).toBe(7);
    expect(out.voteInfo.userInfos).toEqual([
      expect.objectContaining({ uid: 'liker-uid', uin: 20002, nick: '点赞者', count: 3 }),
    ]);
  });

  it('getProfileLike throws on empty result', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({ body: { userLikeInfos: [] } as any })),
    });
    await expect(new ProfileApi(bridge as any).getLike()).rejects.toThrow(/empty/);
  });

  it('getProfileLike resolves uncached liker uins from their profiles', async () => {
    const bridge = mockBridge();
    bridge.identity.findUinByUid.mockReturnValue(null);
    const fetchUserProfileByUid = vi.fn(async (uid: string) => ({
      uid,
      uin: 30003,
      nickname: '陌生点赞者',
    }));
    (bridge.apis.contacts as any).fetchUserProfileByUid = fetchUserProfileByUid;
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({
        body: {
          userLikeInfos: [{
            uid: 'self-uid',
            voteInfo: { userInfos: [{ uid: 'stranger-uid', nick: '陌生点赞者' }] },
          }],
        },
      })),
    });

    const out = await new ProfileApi(bridge as any).getLike();

    expect(fetchUserProfileByUid).toHaveBeenCalledOnce();
    expect(fetchUserProfileByUid).toHaveBeenCalledWith('stranger-uid');
    expect(out.voteInfo.userInfos[0]?.uin).toBe(30003);
  });

  it('getProfileLike surfaces failures while resolving uncached liker uins', async () => {
    const bridge = mockBridge();
    bridge.identity.findUinByUid.mockReturnValue(null);
    (bridge.apis.contacts as any).fetchUserProfileByUid = vi.fn(async () => {
      throw new Error('profile lookup failed');
    });
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({
        body: {
          userLikeInfos: [{
            uid: 'self-uid',
            voteInfo: { userInfos: [{ uid: 'stranger-uid' }] },
          }],
        },
      })),
    });

    await expect(new ProfileApi(bridge as any).getLike())
      .rejects.toThrow('profile lookup failed');
  });

  it('getUnidirectionalFriendList parses the embedded JSON body', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0xe17Resp>>({
        body: { jsonBody: JSON.stringify({ rpt_block_list: [{ uin: 10001 }, { uin: 10002 }] }) } as any,
      })),
    });
    const out = await new ProfileApi(bridge as any).getUnidirectionalFriendList();
    expect(out).toEqual([{ uin: 10001 }, { uin: 10002 }]);
  });

  it('fetchCustomFaceDetails supplements the Faceroam ids with server descriptions (#333)', async () => {
    const bridge = mockBridge();
    const emojiA = '10001_0_0_0_AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA_0_0';
    const emojiB = '10001_0_0_0_BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB_0_0';
    bridge.sendRawPacket
      .mockResolvedValueOnce({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<FaceroamOpResp>({
          retCode: 0,
          item: { faceIds: [emojiA, emojiB] },
        })),
      } as any)
      .mockResolvedValueOnce({
        success: true,
        gotResponse: true,
        errorCode: 0,
        errorMessage: '',
        responseData: Buffer.from(protobuf_encode<OidbBase<CustomFaceModifyResp>>({
          body: {
            retCode: 0,
            entries: [{ emoji: { emojiId: emojiB }, desc: '第二个表情' }],
          },
        })),
      } as any);

    const out = await new ProfileApi(bridge as any).fetchCustomFaceDetails(2);

    expect(bridge.sendRawPacket.mock.calls.map((call) => call[0])).toEqual([
      'Faceroam.OpReq',
      'OidbSvcTrpcTcp.0x902e_1',
    ]);
    const detailRequest = protobuf_decode<OidbBase<CustomFaceMoveBody>>(
      bridge.sendRawPacket.mock.calls[1]![1],
    );
    expect(detailRequest.body?.emojis).toEqual([
      { emojiId: emojiA, md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA' },
      { emojiId: emojiB, md5: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB' },
    ]);
    expect(out).toEqual([
      {
        emojiId: emojiA,
        url: `https://p.qpic.cn/qq_expression/10001/${emojiA}/0`,
        md5: 'AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA',
        desc: '',
      },
      {
        emojiId: emojiB,
        url: `https://p.qpic.cn/qq_expression/10001/${emojiB}/0`,
        md5: 'BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB',
        desc: '第二个表情',
      },
    ]);
  });

  it('fetchCustomFaceDetails returns immediately for count=0', async () => {
    const bridge = mockBridge();
    await expect(new ProfileApi(bridge as any).fetchCustomFaceDetails(0)).resolves.toEqual([]);
    expect(bridge.sendRawPacket).not.toHaveBeenCalled();
  });
});
