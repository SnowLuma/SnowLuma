// highway-client.uploadHighwayHttp 的连接生命周期测试。
//
// 回归覆盖：当上传数据 > HIGHWAY_BLOCK_SIZE (1 MiB) 时，旧实现会复用
// 同一个 TCP socket 在 keep-alive 模式下连续 POST，但 QQ highway 的
// 边缘节点经常在第一次响应后立刻 FIN 关闭，导致第二次 POST 报
// `connection closed before response`。用户上报的 1.19 MB 图片
// （onebot retcode=1200）就是这个分支。
//
// 修复方案：每个 chunk 独立建一个新的 TCP 连接。本测试通过 mock
// `net.createConnection` 计数建连次数，断言每个 chunk 一连接的不变量。

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EventEmitter } from 'events';

// highway-client 解析响应只关心 errorCode === 0 —— 一个完全空的
// RespDataHighwayHead protobuf 体（0 字节）会被解为 ，errorCode
// 是 undefined，走 falsy 通过分支。
//
// HTTP body 是 highway frame：
//   0x28 | head_len(BE32) | body_len(BE32) | head | body | 0x29
function buildEmptyHighwayResponseFrame(): Buffer {
  const frame = Buffer.alloc(10);
  frame[0] = 0x28;
  frame.writeUInt32BE(0, 1); // head_len
  frame.writeUInt32BE(0, 5); // body_len
  frame[9] = 0x29;
  return frame;
}

function buildHttpResponse(frameBody: Buffer): Buffer {
  const headers = [
    'HTTP/1.1 200 OK',
    `Content-Length: ${frameBody.length}`,
    'Connection: close',
    '',
    '',
  ].join('\r\n');
  return Buffer.concat([Buffer.from(headers, 'ascii'), frameBody]);
}

// FakeSocket 模拟 net.Socket 的最小子集。highway-client 用到：
//   - 'data' / 'error' / 'close' 事件
//   - .write(data, cb)  cb 会被 socketWrite 等待
//   - .destroy()
//   - .setTimeout / .once / .removeListener  （继承自 EventEmitter）
class FakeSocket extends EventEmitter {
  destroyed = false;
  // 每个 POST = 2 次 write（HTTP header + body）。第二次 write 落地后
  // 异步回放响应并立刻 close —— 复现 QQ highway 真实行为：响应一发完
  // 就 FIN，旧实现的下一次 POST 必然撞上已关闭的 socket。
  private writeCount = 0;
  private response: Buffer;

  constructor(response: Buffer) {
    super();
    this.response = response;
  }

  setTimeout(_ms: number) { /* no-op */ }

  write(_data: unknown, cb?: (err?: Error) => void): boolean {
    this.writeCount += 1;
    if (this.writeCount === 2) {
      setImmediate(() => {
        this.emit('data', this.response);
        this.emit('close');
      });
    }
    if (cb) cb();
    return true;
  }

  destroy() {
    this.destroyed = true;
  }
}

// vitest 把 vi.mock 工厂 hoist 到文件顶部，所以工厂里不能引用普通的
// 顶层 const —— 那会触发 "Cannot access X before initialization"。
// 用 vi.hoisted 让这两个值跟着 mock 一起被 hoist。
const { createdSockets, createConnectionMock } = vi.hoisted(() => ({
  createdSockets: [] as FakeSocket[],
  createConnectionMock: vi.fn(),
}));

vi.mock('net', () => ({
  default: { createConnection: createConnectionMock },
  createConnection: createConnectionMock,
}));

import { uploadHighwayHttp, type HighwaySession } from '@snowluma/protocol/highway';
import type { BridgeContext } from '@snowluma/protocol/bridge-context';

const HIGHWAY_BLOCK_SIZE = 1024 * 1024;

function makeBridge(): BridgeContext {
  return {
    identity: { uin: '10001' } as unknown,
  } as unknown as BridgeContext;
}

function makeSession(): HighwaySession {
  return {
    sigSession: new Uint8Array([0xAA]),
    sessionKey: new Uint8Array([0xBB]),
    host: '127.0.0.1',
    port: 80,
  };
}

describe('uploadHighwayHttp connection lifecycle', () => {
  beforeEach(() => {
    createdSockets.length = 0;
    createConnectionMock.mockReset();
    createConnectionMock.mockImplementation((_opts: unknown, listener?: () => void) => {
      const sock = new FakeSocket(buildHttpResponse(buildEmptyHighwayResponseFrame()));
      createdSockets.push(sock);
      // net.createConnection 在握手成功后调用 listener。同步触发即可，
      // tcpConnect 的 Promise 会立刻 resolve。
      if (listener) setImmediate(listener);
      return sock as unknown as ReturnType<typeof createConnectionMock>;
    });
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('uses a single TCP connection for a sub-block payload', async () => {
    // 0.5 MiB → 1 chunk。覆盖 PTT / 小图的常见场景。
    const bytes = new Uint8Array(512 * 1024);
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1003, bytes, new Uint8Array(16), new Uint8Array(0),
    );
    expect(createConnectionMock).toHaveBeenCalledTimes(1);
    expect(createdSockets[0]!.destroyed).toBe(true);
  });

  it('uses a fresh TCP connection per chunk for multi-block payloads', async () => {
    // 1.5 MiB → ceil(1.5) = 2 chunks。这正是用户上报的 1.19 MB 图片
    // 触发的代码路径：旧实现复用 socket 时第二次 POST 撞上 keep-alive
    // 关闭，新实现必须为每个 chunk 各开一个 socket。
    const bytes = new Uint8Array(Math.floor(1.5 * HIGHWAY_BLOCK_SIZE));
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1003, bytes, new Uint8Array(16), new Uint8Array(0),
    );
    expect(createConnectionMock).toHaveBeenCalledTimes(2);
    expect(createdSockets).toHaveLength(2);
    for (const sock of createdSockets) {
      expect(sock.destroyed).toBe(true);
    }
  });

  it('opens N connections for N chunks (3 chunks here)', async () => {
    const bytes = new Uint8Array(Math.floor(2.5 * HIGHWAY_BLOCK_SIZE));
    await uploadHighwayHttp(
      makeBridge(), makeSession(), 1004, bytes, new Uint8Array(16), new Uint8Array(0),
    );
    expect(createConnectionMock).toHaveBeenCalledTimes(3);
  });
});
