// MessageApi recall + markRead coverage. (The send* paths live in their
// own test file because they need element-builder fixtures the recall
// paths don't.) Renamed from the legacy `actions/group-message` shape
// after #6 commit 1 moved the recall + markRead helpers onto MessageApi
// and #6 commit 6 absorbed setEssence into InteractionApi.

import { describe, it, expect, vi, beforeEach } from 'vitest';

vi.mock('@snowluma/protocol/bridge-oidb', () => ({
  runOidb: vi.fn(async () => new Uint8Array()),
  makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  encodeOidbEnv: vi.fn(() => new Uint8Array()),
  decodeOidbEnv: vi.fn(() => ({ body: {} })),
}));

import { MessageApi } from '../../src/bridge/apis/message';
import { mockBridge } from './_helpers';

describe('apis/message — recall + markRead', () => {
  beforeEach(() => {
    // No global mock state to reset — sendRawPacket is per-bridge.
  });

  it('recallGroup sends to SsoGroupRecallMsg with the group sequence', async () => {
    const bridge = mockBridge();
    await new MessageApi(bridge as any).recallGroup(12345, 999);
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg');
  });

  it('recallGroup throws when sendRawPacket reports failure', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: 'network down',
        responseData: null,
      })) as any,
    });
    await expect(new MessageApi(bridge as any).recallGroup(12345, 999))
      .rejects.toThrow(/network down/);
  });

  it('recallPrivate resolves the target UID before dispatch', async () => {
    const bridge = mockBridge();
    await new MessageApi(bridge as any).recallPrivate(10001, 100, 200, 123, 1700000000);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg');
  });

  it('markGroupRead and markPrivateRead both hit SsoReadedReport', async () => {
    const bridge = mockBridge();
    const api = new MessageApi(bridge as any);
    await api.markGroupRead(12345, 50);
    await api.markPrivateRead(10001, 60);
    expect(bridge.sendRawPacket).toHaveBeenCalledTimes(2);
    const cmds = bridge.sendRawPacket.mock.calls.map((c: any) => c[0]);
    expect(cmds).toEqual([
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
    ]);
  });
});
