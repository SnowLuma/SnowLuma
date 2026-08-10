import { describe, expect, it, vi } from 'vitest';

const { FakeWebSocket, instances } = vi.hoisted(() => {
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const { EventEmitter } = require('node:events') as typeof import('node:events');
  const instances: FakeWebSocket[] = [];

  class FakeWebSocket extends EventEmitter {
    public readyState = 1;
    public readonly sent: string[] = [];

    constructor(public readonly url: string, _opts: unknown) {
      super();
      instances.push(this);
    }

    send(payload: string, cb?: (err?: Error | null) => void): void {
      this.sent.push(payload);
      cb?.(null);
    }

    close(): void {
      this.readyState = 3;
    }

    terminate(): void {
      this.readyState = 3;
      this.emit('close');
    }
  }

  return { FakeWebSocket, instances };
});

vi.mock('@snowluma/websocket', () => ({ WebSocket: FakeWebSocket }));

import { buildDispatchPayload } from '../src/event-filter';
import { NetworkReloadType, type NetworkAdapterContext } from '../src/network/adapter';
import { WsClientAdapter } from '../src/network/ws-client-adapter';
import type { JsonObject, WsClientNetwork } from '../src/types';

function ctx(): NetworkAdapterContext {
  return {
    uin: '10001',
    api: { processStreamRequest: async () => {} } as never,
    buildLifecycleEvent: () => ({}),
    buildHeartbeatEvent: () => ({}),
  };
}

function cfg(over: Partial<WsClientNetwork> = {}): WsClientNetwork {
  return {
    name: 'ws',
    enabled: true,
    url: 'ws://127.0.0.1:8080/ws',
    role: 'Universal',
    reconnectIntervalMs: 5000,
    messageFormat: 'array',
    reportSelfMessage: false,
    ...over,
  };
}

function groupMessage(groupId: number): JsonObject {
  return {
    post_type: 'message',
    message_type: 'group',
    group_id: groupId,
    user_id: 10001,
    message: [{ type: 'text', data: { text: 'hello' } }],
    raw_message: 'hello',
  };
}

describe('WsClientAdapter group message filter', () => {
  it('filters group messages independently for each ws client', () => {
    instances.length = 0;
    const event = groupMessage(985983966);
    const payload = buildDispatchPayload(event);

    const airi = new WsClientAdapter('airi', cfg({
      name: 'airi',
      url: 'ws://127.0.0.1:8081/ws',
      groupMessageFilter: { mode: 'blacklist', groupIds: [985983966] },
    }), ctx());
    const moe = new WsClientAdapter('moe', cfg({
      name: 'moe',
      url: 'ws://127.0.0.1:8082/ws',
      groupMessageFilter: { mode: 'blacklist', groupIds: [787682322] },
    }), ctx());

    airi.open();
    moe.open();
    airi.onEvent(event, payload);
    moe.onEvent(event, payload);

    expect(instances).toHaveLength(2);
    expect(instances[0].sent).toHaveLength(0);
    expect(instances[1].sent).toHaveLength(1);
  });

  it('hot-reloads only the filter without reopening the websocket', async () => {
    instances.length = 0;
    const adapter = new WsClientAdapter('airi', cfg({
      name: 'airi',
      groupMessageFilter: { mode: 'blacklist', groupIds: [985983966] },
    }), ctx());

    adapter.open();
    expect(instances).toHaveLength(1);

    const result = await adapter.reload(cfg({
      name: 'airi',
      groupMessageFilter: { mode: 'blacklist', groupIds: [787682322] },
    }));

    expect(result).toBe(NetworkReloadType.Normal);
    expect(instances).toHaveLength(1);

    const oldGroup = groupMessage(985983966);
    adapter.onEvent(oldGroup, buildDispatchPayload(oldGroup));
    expect(instances[0].sent).toHaveLength(1);

    const newBlockedGroup = groupMessage(787682322);
    adapter.onEvent(newBlockedGroup, buildDispatchPayload(newBlockedGroup));
    expect(instances[0].sent).toHaveLength(1);
  });
});
