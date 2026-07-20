import { EventEmitter } from 'events';
import { describe, expect, it, vi } from 'vitest';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import { ProtocolSessionManager, type ProtocolHost } from '../src/protocol-session-manager';

class FakeHost extends EventEmitter implements ProtocolHost, PacketSender {
  start = vi.fn(async () => undefined);
  stop = vi.fn(async () => undefined);
  sendPacket = vi.fn(async (): Promise<SendPacketResult> => ({
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.alloc(0),
  }));
}

describe('ProtocolSessionManager', () => {
  it('moves from QR code to online and bridges raw pushes without QQ.exe', async () => {
    const host = new FakeHost();
    const bridgeManager = {
      onHookLogin: vi.fn(),
      onPidDisconnected: vi.fn(),
      onPacket: vi.fn(),
    };
    const manager = new ProtocolSessionManager({
      bridgeManager,
      createHost: () => host,
      createId: () => 'session-1',
    });

    const initial = await manager.startSession();
    expect(initial).toMatchObject({ id: 'session-1', status: 'starting', uin: '' });

    host.emit('qrcode', { url: 'https://txz.qq.com/p?k=1', image: Buffer.from('png') });
    expect(manager.getSession('session-1')).toMatchObject({
      status: 'waiting_scan',
      qrCodeUrl: 'https://txz.qq.com/p?k=1',
    });

    host.emit('online', { uin: '123456' });
    expect(manager.getSession('session-1')).toMatchObject({ status: 'online', uin: '123456' });
    expect(bridgeManager.onHookLogin).toHaveBeenCalledWith(expect.any(Number), '123456', host);

    host.emit('packet', {
      command: 'trpc.msg.olpush.OlPushService.MsgPush',
      sequence: 42,
      retCode: 0,
      body: Buffer.from([9]),
    });
    expect(bridgeManager.onPacket).toHaveBeenCalledWith(expect.objectContaining({
      uin: '123456',
      serviceCmd: 'trpc.msg.olpush.OlPushService.MsgPush',
      seqId: 42,
      body: Buffer.from([9]),
    }));

    await manager.stopSession('session-1');
    expect(bridgeManager.onPidDisconnected).toHaveBeenCalledOnce();
    expect(manager.getSession('session-1')).toBeNull();
  });

  it('keeps a failed host visible with an actionable error', async () => {
    const host = new FakeHost();
    host.start.mockRejectedValueOnce(new Error('protocol host binary is missing'));
    const manager = new ProtocolSessionManager({
      bridgeManager: { onHookLogin: vi.fn(), onPidDisconnected: vi.fn(), onPacket: vi.fn() },
      createHost: () => host,
      createId: () => 'session-2',
    });

    await expect(manager.startSession()).resolves.toMatchObject({
      id: 'session-2',
      status: 'error',
      error: 'protocol host binary is missing',
    });
  });
});
