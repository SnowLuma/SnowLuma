import { describe, it, expect, vi, beforeEach } from 'vitest';

// Stub the OIDB shim so we can assert WHICH command + payload each
// action constructs without booting a real Bridge / native pipe.
vi.mock('../../src/bridge/bridge-oidb', () => ({
  runOidb: vi.fn(async () => ({})),
}));

import * as oidb from '../../src/bridge/bridge-oidb';
import * as admin from '../../src/bridge/actions/group-admin';
import { mockBridge } from './_helpers';

describe('actions/group-admin', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockClear();
  });

  it('muteGroupMember resolves UID and dispatches 0x1253_1', async () => {
    const bridge = mockBridge();
    await admin.muteGroupMember(bridge as any, 12345, 67890, 600);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    expect(oidb.runOidb).toHaveBeenCalledOnce();
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0x1253_1');
    expect(call.oidbCmd).toBe(0x1253);
    expect(call.subCmd).toBe(1);
    expect(call.request.value).toMatchObject({
      groupUin: 12345,
      type: 1,
      body: { targetUid: 'resolved-uid', duration: 600 },
    });
  });

  it('muteGroupAll flips the muteState flag based on enable', async () => {
    const bridge = mockBridge();
    await admin.muteGroupAll(bridge as any, 12345, true);
    expect(vi.mocked(oidb.runOidb).mock.calls[0]![1].request.value).toMatchObject({
      groupUin: 12345,
      muteState: { state: 0xFFFFFFFF },
    });

    await admin.muteGroupAll(bridge as any, 12345, false);
    expect(vi.mocked(oidb.runOidb).mock.calls[1]![1].request.value).toMatchObject({
      muteState: { state: 0 },
    });
  });

  it('kickGroupMember resolves UID per-group and forwards reject + reason', async () => {
    const bridge = mockBridge();
    await admin.kickGroupMember(bridge as any, 12345, 67890, true, 'bad behaviour');
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    expect(vi.mocked(oidb.runOidb).mock.calls[0]![1].request.value).toMatchObject({
      groupUin: 12345,
      targetUid: 'resolved-uid',
      rejectAddRequest: true,
      reason: 'bad behaviour',
    });
  });

  it('kickGroupMembers resolves each UID in parallel', async () => {
    const bridge = mockBridge();
    vi.mocked(bridge.resolveUserUid)
      .mockResolvedValueOnce('uid-a')
      .mockResolvedValueOnce('uid-b');

    await admin.kickGroupMembers(bridge as any, 12345, [11, 22], false);
    expect(bridge.resolveUserUid).toHaveBeenCalledTimes(2);
    const payload: any = vi.mocked(oidb.runOidb).mock.calls[0]![1].request.value;
    expect(payload.targetUids).toEqual(['uid-a', 'uid-b']);
    expect(payload.rejectAddRequest).toBe(0);
  });

  it('leaveGroup sends 0x1097_1 with the groupUin', async () => {
    const bridge = mockBridge();
    await admin.leaveGroup(bridge as any, 12345);
    const call = vi.mocked(oidb.runOidb).mock.calls[0]![1];
    expect(call.cmd).toBe('OidbSvcTrpcTcp.0x1097_1');
    expect(call.request.value).toMatchObject({ groupUin: 12345 });
  });

  it('setGroupAdmin resolves UID and sends 0x1096_1', async () => {
    const bridge = mockBridge();
    await admin.setGroupAdmin(bridge as any, 12345, 67890, true);
    expect(vi.mocked(oidb.runOidb).mock.calls[0]![1].request.value).toMatchObject({
      groupUin: 12345, uid: 'resolved-uid', isAdmin: true,
    });
  });

  it('setGroupCard / setGroupName / setGroupSpecialTitle / setGroupRemark / setGroupAddOption / setGroupSearch dispatch the right command', async () => {
    const bridge = mockBridge();
    await admin.setGroupCard(bridge as any, 1, 2, 'newCard');
    await admin.setGroupName(bridge as any, 1, 'newName');
    await admin.setGroupSpecialTitle(bridge as any, 1, 2, 'newTitle');
    await admin.setGroupRemark(bridge as any, 1, 'newRemark');
    await admin.setGroupAddOption(bridge as any, 1, 2);
    await admin.setGroupSearch(bridge as any, 1);

    const cmds = vi.mocked(oidb.runOidb).mock.calls.map(call => call[1].cmd);
    expect(cmds).toEqual([
      'OidbSvcTrpcTcp.0x8fc_3',
      'OidbSvcTrpcTcp.0x89a_15',
      'OidbSvcTrpcTcp.0x8fc_2',
      'OidbSvcTrpcTcp.0xf16_1',
      'OidbSvcTrpcTcp.0x89a_0',
      'OidbSvcTrpcTcp.0x89a_0',
    ]);
  });

  it('setGroupAddRequest picks _1 / _2 based on filtered flag', async () => {
    const bridge = mockBridge();
    await admin.setGroupAddRequest(bridge as any, 12345, 5, 1, true, 'ok', false);
    await admin.setGroupAddRequest(bridge as any, 12345, 5, 1, false, 'no', true);

    const cmds = vi.mocked(oidb.runOidb).mock.calls.map(call => call[1].cmd);
    expect(cmds).toEqual([
      'OidbSvcTrpcTcp.0x10c8_1',
      'OidbSvcTrpcTcp.0x10c8_2',
    ]);

    const firstBody: any = vi.mocked(oidb.runOidb).mock.calls[0]![1].request.value;
    expect(firstBody.accept).toBe(1);
    expect(firstBody.body.message).toBe('ok');

    const secondBody: any = vi.mocked(oidb.runOidb).mock.calls[1]![1].request.value;
    expect(secondBody.accept).toBe(2);
  });

  it('getGroupAtAllRemain decodes the response and converts BigInts', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce({
      canAtAll: 1,
      groupRemain: 12n,
      uinRemain: 5n,
    });
    const out = await admin.getGroupAtAllRemain(bridge as any, 12345);
    expect(out).toEqual({
      can_at_all: true,
      remain_at_all_count_for_group: 12,
      remain_at_all_count_for_uin: 5,
    });
  });

  it('getGroupAtAllRemain throws when the response is empty', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(null);
    await expect(admin.getGroupAtAllRemain(bridge as any, 12345)).rejects.toThrow(/empty/);
  });
});
