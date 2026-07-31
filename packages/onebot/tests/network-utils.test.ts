import { describe, expect, it, vi } from 'vitest';
import type { WebSocket } from '@snowluma/websocket';
import { StreamTransportClosedError } from '../src/streaming';
import { safeSendAsync } from '../src/network/utils';

describe('safeSendAsync', () => {
  it('resolves after a successful WebSocket write callback', async () => {
    const socket = {
      readyState: 1,
      send: vi.fn((_payload: string, callback: (error?: Error | null) => void) => {
        callback(null);
      }),
    } as unknown as WebSocket;

    await expect(safeSendAsync(socket, 'frame')).resolves.toBeUndefined();
    expect(socket.send).toHaveBeenCalledWith('frame', expect.any(Function));
  });

  it('rejects when the socket is not open', async () => {
    const socket = {
      readyState: 3,
      send: vi.fn(),
    } as unknown as WebSocket;

    await expect(safeSendAsync(socket, 'frame'))
      .rejects.toBeInstanceOf(StreamTransportClosedError);
    expect(socket.send).not.toHaveBeenCalled();
  });

  it('rejects a synchronous WebSocket send failure', async () => {
    const socket = {
      readyState: 1,
      send: vi.fn(() => { throw new Error('socket gone'); }),
    } as unknown as WebSocket;

    await expect(safeSendAsync(socket, 'frame'))
      .rejects.toBeInstanceOf(StreamTransportClosedError);
  });

  it('rejects an asynchronous WebSocket write failure', async () => {
    const socket = {
      readyState: 1,
      send: vi.fn((_payload: string, callback: (error?: Error | null) => void) => {
        callback(new Error('write failed'));
      }),
    } as unknown as WebSocket;

    await expect(safeSendAsync(socket, 'frame'))
      .rejects.toBeInstanceOf(StreamTransportClosedError);
  });
});
