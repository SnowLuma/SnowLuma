import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_encode } from '@snowluma/proton';
import type { OidbBase } from '@snowluma/proto-defs/oidb';
import type { Oidb0x8a7Resp } from '@snowluma/proto-defs/oidb-actions/base';

// `encodeOidbEnv` / `decodeOidbEnv` are proton-bound pass-through wrappers
// that the plugin substitutes at the call site with the inlined codec, so
// mocking them on the module object is a no-op. The only mockable point
// is `runOidb` (non-generic, untouched by proton) returning real bytes
// that the production-side codec then decodes. `makeOidbEnvelope` is a
// pure TS helper, so its mock works for introspection.
vi.mock('@snowluma/bridge/bridge-oidb', async () => {
  const actual = await vi.importActual<typeof import('@snowluma/bridge/bridge-oidb')>(
    '@snowluma/bridge/bridge-oidb',
  );
  return {
    ...actual,
    runOidb: vi.fn(async () => new Uint8Array()),
    makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  };
});

import * as oidb from '@snowluma/bridge/bridge-oidb';
import { GroupAdminApi } from '../../src/bridge/apis/group-admin';
import { mockBridge } from './_helpers';

describe('actions/group-admin', () => {
  beforeEach(() => {
    vi.mocked(oidb.runOidb).mockReset();
    vi.mocked(oidb.runOidb).mockResolvedValue(new Uint8Array());
    vi.mocked(oidb.makeOidbEnvelope).mockClear();
  });

  it('muteGroupMember resolves UID and dispatches 0x1253_1', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).muteMember(12345, 67890, 600);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    expect(oidb.runOidb).toHaveBeenCalledOnce();
    const [, cmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x1253_1');
    const [oidbCmd, subCmd, body] = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]!;
    expect(oidbCmd).toBe(0x1253);
    expect(subCmd).toBe(1);
    expect(body).toMatchObject({
      groupUin: 12345,
      type: 1,
      body: { targetUid: 'resolved-uid', duration: 600 },
    });
  });

  it('muteGroupAll flips the muteState flag based on enable', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).muteAll(12345, true);
    expect(vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2]).toMatchObject({
      groupUin: 12345,
      muteState: { state: 0xFFFFFFFF },
    });

    await new GroupAdminApi(bridge as any).muteAll(12345, false);
    expect(vi.mocked(oidb.makeOidbEnvelope).mock.calls[1]![2]).toMatchObject({
      muteState: { state: 0 },
    });
  });

  it('kickGroupMember resolves UID per-group and forwards reject + reason', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).kickMember(12345, 67890, true, 'bad behaviour');
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(67890, 12345);
    expect(vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2]).toMatchObject({
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

    await new GroupAdminApi(bridge as any).kickMembers(12345, [11, 22], false);
    expect(bridge.resolveUserUid).toHaveBeenCalledTimes(2);
    const payload: any = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(payload.targetUids).toEqual(['uid-a', 'uid-b']);
    expect(payload.rejectAddRequest).toBe(0);
  });

  it('leaveGroup sends 0x1097_1 with the groupUin', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).leave(12345);
    const [, cmd] = vi.mocked(oidb.runOidb).mock.calls[0]!;
    expect(cmd).toBe('OidbSvcTrpcTcp.0x1097_1');
    expect(vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2]).toMatchObject({ groupUin: 12345 });
  });

  it('setGroupAdmin resolves UID and sends 0x1096_1', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).setAdmin(12345, 67890, true);
    expect(vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2]).toMatchObject({
      groupUin: 12345, uid: 'resolved-uid', isAdmin: true,
    });
  });

  it('setGroupCard / setGroupName / setGroupSpecialTitle / setGroupRemark / setGroupAddOption / setGroupSearch dispatch the right command', async () => {
    const bridge = mockBridge();
    await new GroupAdminApi(bridge as any).setCard(1, 2, 'newCard');
    await new GroupAdminApi(bridge as any).setName(1, 'newName');
    await new GroupAdminApi(bridge as any).setSpecialTitle(1, 2, 'newTitle');
    await new GroupAdminApi(bridge as any).setRemark(1, 'newRemark');
    await new GroupAdminApi(bridge as any).setAddOption(1, 2);
    await new GroupAdminApi(bridge as any).setSearch(1);

    const cmds = vi.mocked(oidb.runOidb).mock.calls.map(call => call[1]);
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
    await new GroupAdminApi(bridge as any).setAddRequest(12345, 5, 1, true, 'ok', false);
    await new GroupAdminApi(bridge as any).setAddRequest(12345, 5, 1, false, 'no', true);

    const cmds = vi.mocked(oidb.runOidb).mock.calls.map(call => call[1]);
    expect(cmds).toEqual([
      'OidbSvcTrpcTcp.0x10c8_1',
      'OidbSvcTrpcTcp.0x10c8_2',
    ]);

    const firstBody: any = vi.mocked(oidb.makeOidbEnvelope).mock.calls[0]![2];
    expect(firstBody.accept).toBe(1);
    expect(firstBody.body.message).toBe('ok');

    const secondBody: any = vi.mocked(oidb.makeOidbEnvelope).mock.calls[1]![2];
    expect(secondBody.accept).toBe(2);
  });

  it('getGroupAtAllRemain decodes the response and converts BigInts', async () => {
    const bridge = mockBridge();
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<Oidb0x8a7Resp>>({
        body: { canAtAll: true, groupRemain: 12, uinRemain: 5 } as any,
      }),
    );
    const out = await new GroupAdminApi(bridge as any).getAtAllRemain(12345);
    expect(out).toEqual({
      can_at_all: true,
      remain_at_all_count_for_group: 12,
      remain_at_all_count_for_uin: 5,
    });
  });

  it('getGroupAtAllRemain throws when the response is empty', async () => {
    const bridge = mockBridge();
    // An empty OidbBase envelope (no body) — production code sees `body`
    // undefined and throws the "empty" error.
    vi.mocked(oidb.runOidb).mockResolvedValueOnce(
      protobuf_encode<OidbBase<Oidb0x8a7Resp>>({}),
    );
    await expect(new GroupAdminApi(bridge as any).getAtAllRemain(12345)).rejects.toThrow(/empty/);
  });
});
