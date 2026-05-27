import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type {
  GroupAvatarExtra,
  Oidb0x7edResp,
  Oidb0xe17Resp,
  SetStatusReq,
  SetStatusResp,
} from '@snowluma/proto-defs/oidb-actions/base';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import { beforeEach, describe, expect, it, vi } from 'vitest';

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
}));

vi.mock('@snowluma/protocol/highway/utils', () => ({
  loadBinarySource: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), fileName: 'avatar.bin' })),
  computeHashes: vi.fn(() => ({ md5: new Uint8Array(16), sha1: new Uint8Array(20) })),
  computeMd5: vi.fn(() => new Uint8Array(16)),
}));

import * as oidb from '@snowluma/protocol/bridge-oidb';
import * as highwayClient from '@snowluma/protocol/highway';
import { ProfileApi } from '../../src/account/apis/profile';
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
    await new ProfileApi(bridge as any).setOnlineStatus(11, 0, 100);
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.qq_new_tech.status_svc.StatusService.SetStatus');
  });

  it('setOnlineStatus does NOT include the customExt field 4 (varint 0x22 absent in body)', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setOnlineStatus(11, 0, 100);
    const [, body] = bridge.sendRawPacket.mock.calls[0]!;
    // proto field 4 length-delimited tag = (4 << 3) | 2 = 0x22. The
    // body should not contain that byte; if encoder ever leaks an
    // empty customExt it'd appear here.
    expect(Buffer.from(body).includes(0x22)).toBe(false);
  });

  it('setDiyOnlineStatus hardcodes status=10 / extStatus=2000 and packs faceId+wording+faceType into customExt', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setDiyOnlineStatus(1234, '摸鱼中', 2);
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
    await expect(new ProfileApi(bridge as any).setDiyOnlineStatus(1, 't', 1)).rejects.toThrow(/denied/);
  });

  it('setDiyOnlineStatus rejects when the transport itself fails', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: false, gotResponse: false, errorCode: -1, errorMessage: 'pipe closed', responseData: null,
    } as any);
    await expect(new ProfileApi(bridge as any).setDiyOnlineStatus(1, 't', 1)).rejects.toThrow(/pipe closed/);
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
    await new ProfileApi(bridge as any).setSelfLongNick('hello world');
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0x112a_2');
  });

  it('setInputStatus resolves UID first and sends 0xcd4_1', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setInputStatus(10001, 1);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    expect(bridge.sendRawPacket.mock.calls[0]![0]).toBe('OidbSvcTrpcTcp.0xcd4_1');
  });

  it('setAvatar loads bytes and pushes through the highway upload path (cmd 90)', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setAvatar('/some/avatar.png');
    expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    const [, , cmdId, , , extend] = vi.mocked(highwayClient.uploadHighwayHttp).mock.calls[0]!;
    expect(cmdId).toBe(90);
    expect((extend as Uint8Array).length).toBe(0); // personal avatar has no extra payload
  });

  it('setGroupAvatar uses cmdId 3000 and packs the Lagrange GroupAvatarExtra constants', async () => {
    const bridge = mockBridge();
    await new ProfileApi(bridge as any).setGroupAvatar(12345, '/some/group-avatar.png');
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
    await expect(new ProfileApi(bridge as any).setGroupAvatar(1, 'empty.png')).rejects.toThrow(/empty/);
    expect(highwayClient.fetchHighwaySession).not.toHaveBeenCalled();
  });

  it('getProfileLike (self): resolves self UID, returns formatted favorite + vote info', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({
        body: {
          userLikeInfos: [{
            uid: 'u',
            time: 1700000000n,
            favoriteInfo: { totalCount: 5, lastTime: 1n, newCount: 1 },
            voteInfo: { totalCount: 7, newCount: 2, lastTime: 2n },
          }],
        } as any,
      })),
    });
    const out = await new ProfileApi(bridge as any).getLike();
    expect(out.favoriteInfo.total_count).toBe(5);
    expect(out.voteInfo.total_count).toBe(7);
  });

  it('getProfileLike throws on empty result', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '',
      responseData: Buffer.from(protobuf_encode<OidbBase<Oidb0x7edResp>>({ body: { userLikeInfos: [] } as any })),
    });
    await expect(new ProfileApi(bridge as any).getLike()).rejects.toThrow(/empty/);
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
});
