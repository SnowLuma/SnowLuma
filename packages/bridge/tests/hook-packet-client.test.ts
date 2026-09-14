import { describe, expect, it, vi } from 'vitest';
import { HookPacketClient } from '../src/hook-packet-client';
import {
  HookPipeRequestError,
  PIPE_STATUS_CONNECTION_UNAVAILABLE,
  type QqHookClient,
} from '../src/qq-hook-client';

function fakeClient(send: QqHookClient['send']): QqHookClient {
  return {
    isLoggedIn: true,
    send,
  } as unknown as QqHookClient;
}

describe('HookPacketClient outbound health', () => {
  it('reports native connection loss once and recovers after a successful request', async () => {
    const healthChanged = vi.fn();
    const send = vi
      .fn<QqHookClient['send']>()
      .mockRejectedValueOnce(new HookPipeRequestError(
        'The QQ connection changed. Please restart QQ and try again.',
        PIPE_STATUS_CONNECTION_UNAVAILABLE,
        1,
      ))
      .mockRejectedValueOnce(new HookPipeRequestError(
        'The QQ connection changed. Please restart QQ and try again.',
        PIPE_STATUS_CONNECTION_UNAVAILABLE,
        2,
      ))
      .mockResolvedValueOnce({
        requestId: 3,
        error: 0,
        message: '',
        body: Buffer.from('ok'),
      });
    const sender = new HookPacketClient(fakeClient(send), healthChanged);

    await expect(sender.sendPacket('Test.Command', Buffer.alloc(0)))
      .resolves.toMatchObject({ success: false, gotResponse: false });
    await sender.sendPacket('Test.Command', Buffer.alloc(0));
    await expect(sender.sendPacket('Test.Command', Buffer.alloc(0)))
      .resolves.toMatchObject({ success: true, gotResponse: true });

    expect(healthChanged.mock.calls).toEqual([[false], [true]]);
  });

  it('does not classify ordinary request rejection as connection loss', async () => {
    const healthChanged = vi.fn();
    const send = vi.fn<QqHookClient['send']>().mockRejectedValue(
      new HookPipeRequestError('This request is not valid.', -38, 1),
    );
    const sender = new HookPacketClient(fakeClient(send), healthChanged);

    await expect(sender.sendPacket('Test.Command', Buffer.alloc(0)))
      .resolves.toMatchObject({ success: false, gotResponse: false });

    expect(healthChanged).not.toHaveBeenCalled();
  });
});
