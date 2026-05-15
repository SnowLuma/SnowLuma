import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => ({})),
}));

vi.mock('../../src/bridge/highway/highway-client', () => ({
  fetchHighwaySession: vi.fn(async () => ({})),
  uploadHighwayHttp: vi.fn(async () => undefined),
}));

vi.mock('../../src/bridge/highway/utils', () => ({
  loadBinarySource: vi.fn(async () => ({ bytes: new Uint8Array([1, 2, 3]), fileName: 'avatar.bin' })),
  computeHashes: vi.fn(() => ({ md5: new Uint8Array(16), sha1: new Uint8Array(20) })),
  computeMd5: vi.fn(() => new Uint8Array(16)),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as highwayClient from '../../src/bridge/highway/highway-client';
import * as profile from '../../src/bridge/actions/profile';
import { mockBridge } from './_helpers';

describe('actions/profile', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue({});
    vi.mocked(highwayClient.fetchHighwaySession).mockClear();
    vi.mocked(highwayClient.uploadHighwayHttp).mockClear();
  });

  it('setOnlineStatus sends to status_svc.SetStatus and accepts an empty response', async () => {
    const bridge = mockBridge();
    await profile.setOnlineStatus(bridge as any, 11, 0, 100);
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.qq_new_tech.status_svc.StatusService.SetStatus');
  });

  it('setOnlineStatus does NOT include the customExt field 4 (varint 0x22 absent in body)', async () => {
    const bridge = mockBridge();
    await profile.setOnlineStatus(bridge as any, 11, 0, 100);
    const [, body] = bridge.sendRawPacket.mock.calls[0]!;
    // proto field 4 length-delimited tag = (4 << 3) | 2 = 0x22. The
    // body should not contain that byte; if encoder ever leaks an
    // empty customExt it'd appear here.
    expect(Buffer.from(body).includes(0x22)).toBe(false);
  });

  it('setDiyOnlineStatus hardcodes status=10 / extStatus=2000 and packs faceId+wording+faceType into customExt', async () => {
    const bridge = mockBridge();
    await profile.setDiyOnlineStatus(bridge as any, 1234, '摸鱼中', 2);
    const [serviceCmd, body] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.qq_new_tech.status_svc.StatusService.SetStatus');
    // Decode the wire bytes back through the same schema to assert
    // every field landed in the right place.
    const { protoDecode } = await import('../../src/protobuf/decode');
    const { SetStatusReqSchema } = await import('../../src/bridge/proto/oidb-action');
    const decoded = protoDecode(body as Uint8Array, SetStatusReqSchema);
    expect(decoded).toMatchObject({
      status: 10,
      extStatus: 2000,
      batteryStatus: 0,
      customExt: { faceId: 1234, text: '摸鱼中', faceType: 2 },
    });
  });

  it('setDiyOnlineStatus surfaces server errors via the same path as setOnlineStatus', async () => {
    const bridge = mockBridge();
    // Build a response that decodes to errCode != 0.
    const { protoEncode } = await import('../../src/protobuf/decode');
    const { SetStatusRespSchema } = await import('../../src/bridge/proto/oidb-action');
    const respBuf = Buffer.from(protoEncode({ errCode: 1, errMsg: 'denied' }, SetStatusRespSchema));
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: true, gotResponse: true, errorCode: 0, errorMessage: '', responseData: respBuf,
    } as any);
    await expect(profile.setDiyOnlineStatus(bridge as any, 1, 't', 1)).rejects.toThrow(/denied/);
  });

  it('setDiyOnlineStatus rejects when the transport itself fails', async () => {
    const bridge = mockBridge();
    bridge.sendRawPacket.mockResolvedValueOnce({
      success: false, gotResponse: false, errorCode: -1, errorMessage: 'pipe closed', responseData: null,
    } as any);
    await expect(profile.setDiyOnlineStatus(bridge as any, 1, 't', 1)).rejects.toThrow(/pipe closed/);
  });

  it('setProfile is a no-op when both arguments are undefined', async () => {
    const bridge = mockBridge();
    await profile.setProfile(bridge as any);
    expect(oidb.runOidb).not.toHaveBeenCalled();
  });

  it('setProfile only sends non-undefined fields', async () => {
    const bridge = mockBridge();
    await profile.setProfile(bridge as any, 'New Nick');
    expect(oidb.runOidb).toHaveBeenCalledOnce();
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect((call.request.value as any).stringProfiles).toEqual([{ fieldId: 20002, value: 'New Nick' }]);
  });

  it('setSelfLongNick wraps the long nick in profile tag 102', async () => {
    const bridge = mockBridge();
    await profile.setSelfLongNick(bridge as any, 'hello world');
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect((call.request.value as any).profile).toEqual({ tag: 102, value: 'hello world' });
  });

  it('setInputStatus resolves UID first and sends 0xcd4_1', async () => {
    const bridge = mockBridge();
    await profile.setInputStatus(bridge as any, 10001, 1);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0xcd4_1');
  });

  it('setAvatar loads bytes and pushes through the highway upload path (cmd 90)', async () => {
    const bridge = mockBridge();
    await profile.setAvatar(bridge as any, '/some/avatar.png');
    expect(highwayClient.fetchHighwaySession).toHaveBeenCalledOnce();
    expect(highwayClient.uploadHighwayHttp).toHaveBeenCalledOnce();
    const [, , cmdId] = vi.mocked(highwayClient.uploadHighwayHttp).mock.calls[0]!;
    expect(cmdId).toBe(90);
  });

  it('getProfileLike (self): resolves self UID, returns formatted favorite + vote info', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      userLikeInfos: [{
        uid: 'u',
        time: 1700000000n,
        favoriteInfo: { totalCount: 5, lastTime: 1n, newCount: 1 },
        voteInfo: { totalCount: 7, newCount: 2, lastTime: 2n },
      }],
    });
    const out = await profile.getProfileLike(bridge as any);
    expect(out.favoriteInfo.total_count).toBe(5);
    expect(out.voteInfo.total_count).toBe(7);
  });

  it('getProfileLike throws on empty result', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({ userLikeInfos: [] });
    await expect(profile.getProfileLike(bridge as any)).rejects.toThrow(/empty/);
  });

  it('getUnidirectionalFriendList parses the embedded JSON body', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      jsonBody: JSON.stringify({ rpt_block_list: [{ uin: 10001 }, { uin: 10002 }] }),
    });
    const out = await profile.getUnidirectionalFriendList(bridge as any);
    expect(out).toEqual([{ uin: 10001 }, { uin: 10002 }]);
  });
});
