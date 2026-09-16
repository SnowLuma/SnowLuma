import { describe, expect, it, vi } from 'vitest';
import {
  SnowLumaAbortError,
  SnowLumaWebSocketClient,
  type OneBotPrivateMessageEvent,
} from '../src';

class MockWebSocket {
  static instances: MockWebSocket[] = [];

  readyState = 0;
  sent: string[] = [];
  readonly listeners = new Map<string, Set<(...args: unknown[]) => void>>();

  constructor(
    readonly url: string,
    readonly protocols?: string | string[],
  ) {
    MockWebSocket.instances.push(this);
  }

  addEventListener(event: string, listener: (...args: unknown[]) => void): void {
    let listeners = this.listeners.get(event);
    if (!listeners) {
      listeners = new Set();
      this.listeners.set(event, listeners);
    }
    listeners.add(listener);
  }

  removeEventListener(event: string, listener: (...args: unknown[]) => void): void {
    this.listeners.get(event)?.delete(listener);
  }

  send(data: string): void {
    this.sent.push(data);
  }

  close(code?: number, reason?: string): void {
    this.readyState = 3;
    this.emit('close', { code, reason });
  }

  open(): void {
    this.readyState = 1;
    this.emit('open');
  }

  message(data: unknown): void {
    this.emit('message', { data });
  }

  emit(event: string, ...args: unknown[]): void {
    for (const listener of this.listeners.get(event) ?? []) {
      listener(...args);
    }
  }
}

const PRIVATE_EVENT: OneBotPrivateMessageEvent = {
  time: 1,
  self_id: 10000,
  post_type: 'message',
  message_type: 'private',
  sub_type: 'friend',
  message_id: 7,
  message_seq: 8,
  user_id: 10001,
  message: [{ type: 'text', data: { text: '/ping a b' } }],
  raw_message: '/ping a b',
  font: 0,
  sender: { user_id: 10001, nickname: 'tester' },
};

describe('SnowLumaWebSocketClient', () => {
  it('matches API responses by echo', async () => {
    MockWebSocket.instances = [];
    const client = new SnowLumaWebSocketClient({
      url: 'ws://127.0.0.1:3001/',
      accessToken: 'token',
      webSocket: MockWebSocket,
    });

    const connecting = client.connect();
    const socket = MockWebSocket.instances[0]!;
    expect(socket.url).toContain('access_token=token');
    socket.open();
    await connecting;

    const status = client.getStatus();
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    const request = JSON.parse(socket.sent[0]!) as { echo: string };
    socket.message(JSON.stringify({
      status: 'ok',
      retcode: 0,
      data: { online: true, good: true },
      echo: request.echo,
    }));

    await expect(status).resolves.toEqual({ online: true, good: true });
  });

  it('runs command handlers for matching message events', async () => {
    MockWebSocket.instances = [];
    const client = new SnowLumaWebSocketClient({
      url: 'ws://127.0.0.1:3001/',
      webSocket: MockWebSocket,
    });
    const handler = vi.fn();
    client.command('ping', handler);

    const connecting = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await connecting;
    socket.message(JSON.stringify(PRIVATE_EVENT));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![2]).toMatchObject({ args: ['a', 'b'] });
    });
  });

  it('supports caller AbortSignal cancellation for pending requests', async () => {
    MockWebSocket.instances = [];
    const client = new SnowLumaWebSocketClient({
      url: 'ws://127.0.0.1:3001/',
      webSocket: MockWebSocket,
    });
    const controller = new AbortController();

    const connecting = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await connecting;

    const request = client.getStatus({ signal: controller.signal });
    await vi.waitFor(() => expect(socket.sent).toHaveLength(1));
    controller.abort();

    await expect(request).rejects.toBeInstanceOf(SnowLumaAbortError);
  });

  it('dispatches bot_status notices to onBotStatus', async () => {
    MockWebSocket.instances = [];
    const client = new SnowLumaWebSocketClient({
      url: 'ws://127.0.0.1:3001/',
      webSocket: MockWebSocket,
    });
    const handler = vi.fn();
    client.onBotStatus(handler);

    const connecting = client.connect();
    const socket = MockWebSocket.instances[0]!;
    socket.open();
    await connecting;
    socket.message(JSON.stringify({
      time: 1_710_000_000,
      self_id: 10000,
      post_type: 'notice',
      notice_type: 'bot_status',
      sub_type: 'offline',
      user_id: 10000,
    }));

    await vi.waitFor(() => {
      expect(handler).toHaveBeenCalledTimes(1);
      expect(handler.mock.calls[0]![0]).toMatchObject({
        notice_type: 'bot_status',
        sub_type: 'offline',
        user_id: 10000,
      });
    });
  });
});
