import net from 'net';
import { mkdtemp, rm, writeFile } from 'fs/promises';
import os from 'os';
import path from 'path';
import { Duplex } from 'stream';
import {
  currentRequestId,
  getLogLevel,
  runWithRequestId,
  setLogLevel,
  subscribeLogs,
  type LogEntry,
} from '@snowluma/common/logger';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  HEADER_SIZE,
  listLiveLinuxPipePids,
  PIPE_MAGIC,
  PIPE_VERSION,
  PipeOp,
  QqHookClient,
} from '../src/qq-hook-client';

let tmpDir: string | null = null;
const previousLogLevel = getLogLevel();

async function makeRuntimeDir(): Promise<string> {
  tmpDir = await mkdtemp(path.join(os.tmpdir(), 'snowluma-hook-'));
  return tmpDir;
}

function pipeFrame({
  op,
  requestId = 0,
  status = 0,
  value0 = 0n,
  cmd = '',
  message = '',
  body = Buffer.alloc(0),
}: {
  op: PipeOp;
  requestId?: number;
  status?: number;
  value0?: bigint;
  cmd?: string;
  message?: string;
  body?: Buffer;
}): Buffer {
  const cmdBytes = Buffer.from(cmd);
  const messageBytes = Buffer.from(message);
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(PIPE_MAGIC, 0);
  header.writeUInt16LE(PIPE_VERSION, 4);
  header.writeUInt16LE(op, 6);
  header.writeUInt32LE(requestId, 8);
  header.writeInt32LE(status, 12);
  header.writeUInt32LE(cmdBytes.length, 20);
  header.writeUInt32LE(messageBytes.length, 24);
  header.writeUInt32LE(body.length, 28);
  header.writeBigUInt64LE(value0, 32);
  return Buffer.concat([header, cmdBytes, messageBytes, body]);
}

function readSendFrame(payload: Buffer): {
  requestId: number;
  cmd: string;
  body: Buffer;
} {
  const cmdLength = payload.readUInt32LE(20);
  const messageLength = payload.readUInt32LE(24);
  const bodyLength = payload.readUInt32LE(28);
  const cmdStart = HEADER_SIZE;
  const bodyStart = cmdStart + cmdLength + messageLength;
  return {
    requestId: payload.readUInt32LE(8),
    cmd: payload.subarray(cmdStart, cmdStart + cmdLength).toString(),
    body: Buffer.from(payload.subarray(bodyStart, bodyStart + bodyLength)),
  };
}

function mockControlPipe(
  pid: number,
  onWrite: (socket: net.Socket, payload: Buffer) => void,
): ReturnType<typeof vi.spyOn> {
  return vi.spyOn(net, 'createConnection').mockImplementation((() => {
    const socket = new Duplex({
      read() { /* peer data is injected with emit('data') */ },
      write(chunk, _encoding, callback) {
        onWrite(socket, Buffer.from(chunk));
        callback();
      },
    }) as net.Socket;
    queueMicrotask(() => {
      socket.emit('connect');
      queueMicrotask(() => socket.emit('data', pipeFrame({
        op: PipeOp.hello,
        value0: BigInt(pid),
      })));
    });
    return socket;
  }) as typeof net.createConnection);
}

function traceMessages(entries: LogEntry[]): string[] {
  return entries
    .filter((entry) => entry.level === 'trace' && entry.scope === 'QQHook.Packet')
    .map((entry) => entry.message);
}

function runtimeTrace(entries: LogEntry[]): LogEntry[] {
  return entries.filter(
    (entry) => entry.level === 'trace' && entry.scope === 'QQHook.Runtime',
  );
}

afterEach(async () => {
  setLogLevel(previousLogLevel);
  vi.restoreAllMocks();
  if (!tmpDir) return;
  await rm(tmpDir, { recursive: true, force: true });
  tmpDir = null;
});

describe('listLiveLinuxPipePids', () => {
  it('ignores stale-looking control socket names when the probe rejects them', async () => {
    const runtimeDir = await makeRuntimeDir();
    await writeFile(path.join(runtimeDir, 'mojo.55.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.55.recv.sock'), '');

    const pids = await listLiveLinuxPipePids(runtimeDir, async () => false);

    expect([...pids]).toEqual([]);
  });

  it('returns only connectable control sockets', async () => {
    const runtimeDir = await makeRuntimeDir();
    await writeFile(path.join(runtimeDir, 'mojo.55.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.56.control.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.56.recv.sock'), '');
    await writeFile(path.join(runtimeDir, 'mojo.not-a-pid.control.sock'), '');

    const probe = vi.fn(async (socketPath: string) => socketPath.endsWith('mojo.56.control.sock'));
    const pids = await listLiveLinuxPipePids(runtimeDir, probe);

    expect([...pids]).toEqual([56]);
    expect(probe).toHaveBeenCalledTimes(2);
  });
});

describe('QqHookClient — runtime TRACE', () => {
  it('records control and receive pipe hello lifecycles under the parent request', async () => {
    const pid = 778820;
    const entries: LogEntry[] = [];
    let connectionIndex = 0;
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const createConnection = vi.spyOn(net, 'createConnection').mockImplementation((() => {
      const kind = connectionIndex === 0 ? 'control' : 'recv';
      connectionIndex += 1;
      const socket = new Duplex({
        read() { /* peer data is injected with emit('data') */ },
      }) as net.Socket;
      queueMicrotask(() => {
        socket.emit('connect');
        queueMicrotask(() => socket.emit('data', pipeFrame({
          op: PipeOp.hello,
          value0: BigInt(pid),
          message: `${kind}-fixture`,
        })));
      });
      return socket;
    }) as typeof net.createConnection);
    const client = new QqHookClient(pid);
    try {
      await runWithRequestId(4201, () => client.connectAll());

      const trace = runtimeTrace(entries);
      expect(trace).toHaveLength(6);
      expect(trace.every((entry) => entry.req === 4201)).toBe(true);
      expect(trace.map((entry) => entry.message)).toEqual([
        expect.stringMatching(/^hook_pipe_start pid=778820 kind=control pipeName=.*$/),
        expect.stringMatching(/^hook_pipe_branch pid=778820 kind=control branch=socket_connected$/),
        expect.stringMatching(/^hook_pipe_terminal pid=778820 kind=control outcome=completed reason=hello_received hello=\{pipeName:"control-fixture",pid:778820,recvPipe:false\} elapsedMs=\d+$/),
        expect.stringMatching(/^hook_pipe_start pid=778820 kind=recv pipeName=.*$/),
        expect.stringMatching(/^hook_pipe_branch pid=778820 kind=recv branch=socket_connected$/),
        expect.stringMatching(/^hook_pipe_terminal pid=778820 kind=recv outcome=completed reason=hello_received hello=\{pipeName:"recv-fixture",pid:778820,recvPipe:true\} elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
      client.close();
      createConnection.mockRestore();
    }
  });

  it('records a pre-request connection failure without a pipe request id', async () => {
    const pid = 778821;
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const createConnection = vi.spyOn(net, 'createConnection').mockImplementation((() => {
      const socket = new Duplex({ read() { /* no peer */ } }) as net.Socket;
      queueMicrotask(() => socket.emit('error', new Error('fixture connect failure')));
      return socket;
    }) as typeof net.createConnection);
    const client = new QqHookClient(pid);
    try {
      await expect(client.connect()).rejects.toThrow('fixture connect failure');

      const trace = runtimeTrace(entries);
      expect(trace).toHaveLength(2);
      expect(trace.every((entry) => entry.req !== undefined)).toBe(true);
      expect(trace[0]!.req).toBe(trace[1]!.req);
      expect(trace.map((entry) => entry.message)).toEqual([
        expect.stringMatching(/^hook_pipe_start pid=778821 kind=control pipeName=.*$/),
        expect.stringMatching(/^hook_pipe_terminal pid=778821 kind=control outcome=failed reason=connect_failed error="fixture connect failure" elapsedMs=\d+$/),
      ]);
      expect(trace.map((entry) => entry.message).join('\n')).not.toContain('requestId=');
    } finally {
      unsubscribe();
      client.close();
      createConnection.mockRestore();
    }
  });

  it('assigns fresh request contexts to material login and close events only', async () => {
    const pid = 778822;
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const connection = mockControlPipe(pid, () => { /* no packet writes */ });
    const client = new QqHookClient(pid);
    const eventRequestIds: Array<{ event: 'login' | 'close'; req: number | undefined }> = [];
    client.on('loginState', () => {
      eventRequestIds.push({ event: 'login', req: currentRequestId() });
    });
    client.on('close', () => {
      eventRequestIds.push({ event: 'close', req: currentRequestId() });
    });
    try {
      await runWithRequestId(4202, () => client.connect());
      const controlSocket = connection.mock.results[0]!.value as net.Socket;
      controlSocket.emit('data', pipeFrame({
        op: PipeOp.loginState,
        status: 1,
        value0: 123456n,
        message: '123456',
      }));
      controlSocket.emit('data', pipeFrame({
        op: PipeOp.loginState,
        status: 1,
        value0: 123456n,
        message: '123456',
      }));
      controlSocket.destroy();
      await new Promise<void>((resolve) => setImmediate(resolve));

      const facts = runtimeTrace(entries).filter(
        (entry) => entry.message.startsWith('hook_runtime_fact pid=778822 '),
      );
      expect(facts).toHaveLength(2);
      expect(facts.every((entry) => entry.req !== undefined)).toBe(true);
      expect(facts[0]!.req).not.toBe(facts[1]!.req);
      expect(facts.map((entry) => entry.message)).toEqual([
        'hook_runtime_fact pid=778822 event=login_state_changed previousLoggedIn=false previousUin="0" loggedIn=true uin="123456"',
        'hook_runtime_fact pid=778822 event=pipe_closed kind=control loggedIn=true uin="123456"',
      ]);
      expect(eventRequestIds).toEqual([
        { event: 'login', req: facts[0]!.req },
        { event: 'login', req: undefined },
        { event: 'close', req: facts[1]!.req },
      ]);
    } finally {
      unsubscribe();
      client.close();
      connection.mockRestore();
    }
  });
});

describe('QqHookClient — packet TRACE', () => {
  it('records complete request and reply bodies with the real pipe request id', async () => {
    const pid = 778810;
    const requestBody = Buffer.from([
      0x00, 0xff, ...Array.from({ length: 160 }, (_, index) => index & 0xff),
    ]);
    const replyBody = Buffer.from([0xff, 0x00, 0x7f]);
    const entries: LogEntry[] = [];
    const writes: Buffer[] = [];
    let traceCountAtWrite = 0;
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const connection = mockControlPipe(pid, (socket, payload) => {
      const frame = readSendFrame(payload);
      writes.push(payload);
      traceCountAtWrite = traceMessages(entries).length;
      queueMicrotask(() => {
        socket.emit('data', pipeFrame({ op: PipeOp.sendAck, requestId: frame.requestId }));
        socket.emit('data', pipeFrame({
          op: PipeOp.sendReply,
          requestId: frame.requestId,
          status: 27,
          message: 'fixture reply',
          body: replyBody,
        }));
      });
    });
    const client = new QqHookClient(pid);
    try {
      const reply = await runWithRequestId(
        4101,
        () => client.sendAndWait('OidbSvcTrpcTcp.0x1234_1', requestBody),
      );

      const sent = readSendFrame(writes[0]);
      expect(sent).toMatchObject({
        requestId: 1,
        cmd: 'OidbSvcTrpcTcp.0x1234_1',
        body: requestBody,
      });
      expect(reply).toMatchObject({
        requestId: 1,
        error: 27,
        message: 'fixture reply',
        body: replyBody,
      });
      expect(traceCountAtWrite).toBe(1);
      expect(entries.filter((entry) => entry.scope === 'QQHook.Packet'))
        .toEqual(expect.arrayContaining([
          expect.objectContaining({
            req: 4101,
            message: `packet_send serviceCmd="OidbSvcTrpcTcp.0x1234_1" requestId=1 length=${requestBody.length} body=${requestBody.toString('hex')}`,
          }),
          expect.objectContaining({
            req: 4101,
            message: `packet_recv serviceCmd="OidbSvcTrpcTcp.0x1234_1" requestId=1 error=27 message="fixture reply" length=${replyBody.length} body=${replyBody.toString('hex')}`,
          }),
          expect.objectContaining({
            req: 4101,
            message: expect.stringMatching(/^packet_terminal serviceCmd="OidbSvcTrpcTcp\.0x1234_1" requestId=1 outcome=failed reason=reply_error error=27 elapsedMs=\d+$/),
          }),
        ]));
      for (const message of traceMessages(entries)) expect(message).not.toContain('...');
    } finally {
      unsubscribe();
      client.close();
      connection.mockRestore();
    }
  });

  it('records empty request and reply bodies exactly', async () => {
    const pid = 778811;
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const connection = mockControlPipe(pid, (socket, payload) => {
      const { requestId } = readSendFrame(payload);
      queueMicrotask(() => {
        socket.emit('data', pipeFrame({ op: PipeOp.sendAck, requestId }));
        socket.emit('data', pipeFrame({ op: PipeOp.sendReply, requestId }));
      });
    });
    const client = new QqHookClient(pid);
    try {
      await client.sendAndWait('Empty.Command', Buffer.alloc(0));

      expect(traceMessages(entries)).toEqual([
        'packet_send serviceCmd="Empty.Command" requestId=1 length=0 body=',
        'packet_recv serviceCmd="Empty.Command" requestId=1 error=0 message="" length=0 body=',
        expect.stringMatching(/^packet_terminal serviceCmd="Empty\.Command" requestId=1 outcome=ok reason=reply_received error=0 elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
      client.close();
      connection.mockRestore();
    }
  });

  it('records no-reply acknowledgement as the terminal outcome', async () => {
    const pid = 778812;
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const connection = mockControlPipe(pid, (socket, payload) => {
      const { requestId } = readSendFrame(payload);
      queueMicrotask(() => {
        socket.emit('data', pipeFrame({ op: PipeOp.sendAck, requestId }));
      });
    });
    const client = new QqHookClient(pid);
    try {
      await client.sendNoReply('NoReply.Command', Buffer.from([0x00, 0xff]));

      expect(traceMessages(entries)).toEqual([
        'packet_send serviceCmd="NoReply.Command" requestId=1 length=2 body=00ff',
        expect.stringMatching(/^packet_terminal serviceCmd="NoReply\.Command" requestId=1 outcome=ok reason=ack_received elapsedMs=\d+$/),
      ]);
    } finally {
      unsubscribe();
      client.close();
      connection.mockRestore();
    }
  });

  it('records reply timeout and transport failure with their real request ids', async () => {
    vi.useFakeTimers();
    const pid = 778813;
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    let writeCount = 0;
    const connection = mockControlPipe(pid, (socket, payload) => {
      const { requestId } = readSendFrame(payload);
      writeCount += 1;
      if (writeCount === 1) {
        queueMicrotask(() => {
          socket.emit('data', pipeFrame({ op: PipeOp.sendAck, requestId }));
        });
        return;
      }
      queueMicrotask(() => socket.destroy());
    });
    const client = new QqHookClient(pid);
    client.on('error', () => { /* expected transport failure */ });
    try {
      const timedOut = client.sendAndWait('Timeout.Command', Buffer.from([0xff]), {
        ackTimeoutMs: 50,
        replyTimeoutMs: 50,
      });
      const timedOutOutcome = timedOut.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(50);
      const timeoutError = await timedOutOutcome;
      expect(timeoutError).toBeInstanceOf(Error);
      expect((timeoutError as Error).message).toBe('send reply 1 timed out after 50 ms');

      const failed = client.sendAndWait('Closed.Command', Buffer.from([0x00]), {
        ackTimeoutMs: 50,
        replyTimeoutMs: 50,
      });
      await expect(failed).rejects.toThrow('control pipe closed');

      expect(traceMessages(entries)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^packet_terminal serviceCmd="Timeout\.Command" requestId=1 outcome=timeout reason=reply_timeout error="send reply 1 timed out after 50 ms" elapsedMs=\d+$/),
        expect.stringMatching(/^packet_terminal serviceCmd="Closed\.Command" requestId=2 outcome=failed reason=transport_failure error="control pipe closed" elapsedMs=\d+$/),
      ]));
    } finally {
      unsubscribe();
      client.close();
      connection.mockRestore();
      vi.useRealTimers();
    }
  });

  it('classifies acknowledgement timeout and pipe request failure', async () => {
    vi.useFakeTimers();
    const pid = 778815;
    const entries: LogEntry[] = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    let writeCount = 0;
    const connection = mockControlPipe(pid, (socket, payload) => {
      const { requestId } = readSendFrame(payload);
      writeCount += 1;
      if (writeCount === 2) {
        queueMicrotask(() => socket.emit('data', pipeFrame({
          op: PipeOp.error,
          requestId,
          status: 12,
          message: 'send ack 2 timed out after 25 ms',
        })));
      }
    });
    const client = new QqHookClient(pid);
    try {
      const timedOut = client.sendNoReply('Ack.Timeout', Buffer.from([0x00]), {
        ackTimeoutMs: 25,
      });
      const timedOutOutcome = timedOut.then(
        () => null,
        (error: unknown) => error,
      );
      await vi.advanceTimersByTimeAsync(25);
      expect(await timedOutOutcome).toMatchObject({
        message: 'send ack 1 timed out after 25 ms',
      });

      await expect(client.sendAndWait(
        'Pipe.Error',
        Buffer.from([0xff]),
      )).rejects.toThrow('send ack 2 timed out after 25 ms');

      expect(traceMessages(entries)).toEqual(expect.arrayContaining([
        expect.stringMatching(/^packet_terminal serviceCmd="Ack\.Timeout" requestId=1 outcome=timeout reason=ack_timeout error="send ack 1 timed out after 25 ms" elapsedMs=\d+$/),
        expect.stringMatching(/^packet_terminal serviceCmd="Pipe\.Error" requestId=2 outcome=failed reason=request_failed error="send ack 2 timed out after 25 ms" elapsedMs=\d+$/),
      ]));
    } finally {
      unsubscribe();
      client.close();
      connection.mockRestore();
      vi.useRealTimers();
    }
  });

  it('keeps concurrent packet records atomic with distinct real request ids', async () => {
    const pid = 778816;
    const entries: LogEntry[] = [];
    const writes: Array<ReturnType<typeof readSendFrame>> = [];
    setLogLevel('trace');
    const unsubscribe = subscribeLogs((entry) => entries.push(entry));
    const connection = mockControlPipe(pid, (socket, payload) => {
      writes.push(readSendFrame(payload));
      if (writes.length !== 2) return;
      queueMicrotask(() => {
        for (const frame of [...writes].reverse()) {
          socket.emit('data', pipeFrame({
            op: PipeOp.sendAck,
            requestId: frame.requestId,
          }));
          socket.emit('data', pipeFrame({
            op: PipeOp.sendReply,
            requestId: frame.requestId,
            body: Buffer.from(frame.body).reverse(),
          }));
        }
      });
    });
    const client = new QqHookClient(pid);
    const firstBody = Buffer.from([0x00, 0xff]);
    const secondBody = Buffer.from(
      Array.from({ length: 160 }, (_, index) => index & 0xff),
    );
    try {
      const [first, second] = await Promise.all([
        client.sendAndWait('First\nCommand', firstBody),
        client.sendAndWait('Second.Command', secondBody),
      ]);

      expect([first.requestId, second.requestId]).toEqual([1, 2]);
      expect(writes.map((frame) => frame.requestId)).toEqual([1, 2]);
      const messages = traceMessages(entries);
      expect(messages).toHaveLength(6);
      expect(messages.every((message) => !message.includes('\n'))).toBe(true);
      expect(messages).toEqual(expect.arrayContaining([
        `packet_send serviceCmd="First\\nCommand" requestId=1 length=2 body=${firstBody.toString('hex')}`,
        `packet_recv serviceCmd="First\\nCommand" requestId=1 error=0 message="" length=2 body=${Buffer.from(firstBody).reverse().toString('hex')}`,
        `packet_send serviceCmd="Second.Command" requestId=2 length=${secondBody.length} body=${secondBody.toString('hex')}`,
        `packet_recv serviceCmd="Second.Command" requestId=2 error=0 message="" length=${secondBody.length} body=${Buffer.from(secondBody).reverse().toString('hex')}`,
      ]));
      expect(messages.filter((message) => message.startsWith('packet_terminal'))).toHaveLength(2);
    } finally {
      unsubscribe();
      client.close();
      connection.mockRestore();
    }
  });

  it('does not evaluate packet TRACE producers while TRACE is disabled', async () => {
    const pid = 778814;
    setLogLevel('debug');
    const byteLength = vi.spyOn(Buffer.prototype, 'toString');
    const connection = mockControlPipe(pid, (socket, payload) => {
      const { requestId } = readSendFrame(payload);
      queueMicrotask(() => {
        socket.emit('data', pipeFrame({ op: PipeOp.sendAck, requestId }));
        socket.emit('data', pipeFrame({ op: PipeOp.sendReply, requestId }));
      });
    });
    const client = new QqHookClient(pid);
    try {
      await client.sendAndWait('Disabled.Command', Buffer.from([0x00, 0xff]));

      expect(byteLength).not.toHaveBeenCalledWith('hex');
    } finally {
      client.close();
      connection.mockRestore();
      byteLength.mockRestore();
    }
  });
});

describe('QqHookClient — pipe close mid-send', () => {
  // Regression: when the control pipe closes while a send() is awaiting its
  // ack, rejectControlPending() rejects BOTH the ack and reply deferreds. The
  // reply is only `await`ed after the ack, so if the ack rejects first the
  // reply promise is rejected with NO awaiter — an UNHANDLED rejection that
  // crashes the Node process (Docker: supervisor restarts it ~1s later; on
  // Windows it just dies → "connection pipe closed", bot down). The .catch()
  // guard on each deferred prevents it; without the guard this test trips the
  // unhandledRejection assertion below.
  it('does not raise an unhandled rejection', async () => {
    const PID = 778899;
    const helloFrame = (): Buffer => {
      const h = Buffer.alloc(40);
      h.writeUInt32LE(0x31504851, 0);       // PIPE_MAGIC
      h.writeUInt16LE(1, 4);                // PIPE_VERSION
      h.writeUInt16LE(1, 6);                // PipeOp.hello
      h.writeBigUInt64LE(BigInt(PID), 32);  // value0 = pid
      return h;
    };

    let controlConn: net.Socket | null = null;
    let signalControlWrite!: () => void;
    const controlWriteStarted = new Promise<void>((resolve) => { signalControlWrite = resolve; });
    const createConnection = vi.spyOn(net, 'createConnection').mockImplementation((() => {
      const socket = new Duplex({
        read() { /* peer data is injected with emit('data') */ },
        write(_chunk, _encoding, callback) {
          signalControlWrite();
          callback();
        },
      }) as net.Socket;
      controlConn = socket;
      queueMicrotask(() => {
        socket.emit('connect');
        queueMicrotask(() => socket.emit('data', helloFrame()));
      });
      return socket;
    }) as typeof net.createConnection);

    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => { unhandled.push(reason); };
    process.on('unhandledRejection', onUnhandled);

    const client = new QqHookClient(PID);
    client.on('error', () => { /* socket reset on destroy — ignore */ });
    try {
      await client.connect();

      // Start a reply-expecting send, let it reach the in-flight (awaiting-ack)
      // state, then have the "hook" drop the pipe before it answers.
      const sent = client.send('noop', null, { wantReply: true, ackTimeoutMs: 1000, replyTimeoutMs: 1000 })
        .then(() => 'resolved' as const, (e: unknown) => e);
      await controlWriteStarted;
      controlConn?.destroy();

      const outcome = await sent;
      await new Promise<void>((resolve) => setImmediate(resolve));

      expect(outcome).toBeInstanceOf(Error);
      expect((outcome as Error).message).toBe('control pipe closed');
      expect(unhandled, `unhandled rejections leaked: ${unhandled.map(String).join(', ')}`).toHaveLength(0);
    } finally {
      process.off('unhandledRejection', onUnhandled);
      client.close();
      createConnection.mockRestore();
    }
  });
});
