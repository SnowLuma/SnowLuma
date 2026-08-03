import { EventEmitter } from 'events';
import {
  createLogger,
  renderTraceBytes,
  runWithoutRequestContext,
  runWithTraceRequest,
} from '@snowluma/common/logger';
import { renderParamsVerbose } from '@snowluma/common/log-summary';
import { isRealUin } from '@snowluma/common/uin';
import { readdirSync, promises as fs } from 'fs';
import net from 'net';
import path from 'path';
import { resolveHookRuntimeDir } from './hook-runtime-dir';

export const PIPE_MAGIC = 0x31504851;
export const PIPE_VERSION = 1;
export const HEADER_SIZE = 40;
// Keep these byte limits in lockstep with nnphook's pipe_protocol.hpp. The
// native readers already enforce them; mirroring them here prevents the JS
// endpoint from buffering frames that the peer can never accept.
export const MAX_PIPE_CMD_BYTES = 4096;
export const MAX_PIPE_MSG_BYTES = 65536;
export const MAX_PIPE_BODY_BYTES = 16 * 1024 * 1024;
export const DEFAULT_ACK_TIMEOUT_MS = 5000;
export const DEFAULT_REPLY_TIMEOUT_MS = 30000;
const DEFAULT_PIPE_PROBE_TIMEOUT_MS = 250;
const packetLog = createLogger('QQHook.Packet');
const runtimeLog = createLogger('QQHook.Runtime');

export enum PipeOp {
  hello = 1,
  sendRequest = 2,
  sendAck = 3,
  sendReply = 4,
  error = 5,
  recvPacket = 6,
  loginState = 7,
  loginIdentityHint = 17,
}

const PipeFlagWantReply = 1 << 0;
const PipeFlagLoggedIn = 1 << 2;

export interface QqHookLoginState {
  loggedIn: boolean;
  uin: string;
  uinNumber: bigint;
}

export interface QqHookPacket {
  seq: number;
  error: number;
  cmd: string;
  uin: string;
  body: Buffer;
}

export interface QqHookHello {
  pipeName: string;
  pid: number;
  recvPipe: boolean;
}

export interface QqHookSendReply {
  requestId: number;
  error: number;
  message: string;
  body: Buffer;
}

export interface QqHookClientOptions {
  ackTimeoutMs?: number;
  replyTimeoutMs?: number;
  runtimeDir?: string;
}

export interface QqHookSendOptions {
  wantReply?: boolean;
  ackTimeoutMs?: number;
  replyTimeoutMs?: number;
}

interface PipeFrame {
  op: number;
  requestId: number;
  status: number;
  flags: number;
  value0: bigint;
  cmd: string;
  msg: string;
  body: Buffer;
}

interface Deferred<T> {
  promise: Promise<T>;
  resolve: (value: T | PromiseLike<T>) => void;
  reject: (reason?: unknown) => void;
}

interface PendingAck {
  resolve: (value: { requestId: number; wantReply: boolean }) => void;
  reject: (reason?: unknown) => void;
  wantReply: boolean;
}

function isMissingDirectoryError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT' || code === 'ENOTDIR';
}

function isUnavailableSocketError(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException | undefined)?.code;
  return code === 'ENOENT'
    || code === 'ENOTDIR'
    || code === 'ENOTSOCK'
    || code === 'ECONNREFUSED'
    || code === 'ECONNRESET';
}

/**
 * Sync directory scan for `mojo.<pid>.control.sock` socket files in the
 * runtime dir, returning the pid set. Used by the darwin path of
 * `listHookProcesses()` — on macOS the DYLD_INSERT injection model means
 * there is no native enumerate-QQ-processes addon; the existence of our
 * dylib's listener socket IS the proof that a QQ process is hooked. The
 * sync variant is needed because the watcher's `listProcesses` dep is sync.
 *
 * Mirrors `listLiveLinuxPipePids` (the async + connectable-probe variant)
 * but skips the connectable probe — the existence of the socket file is
 * sufficient signal for "process exists with our dylib mapped". The async
 * variant still gates the subsequent `pipe-up` emit via a real connect.
 */
export function listSnowlumaPipePidsSync(
  runtimeDir = resolveHookRuntimeDir(),
): Set<number> {
  const result = new Set<number>();
  let names: string[];
  try {
    names = readdirSync(runtimeDir);
  } catch (error) {
    if (isMissingDirectoryError(error)) return result;
    throw error;
  }
  for (const name of names) {
    const m = /^mojo\.(\d+)\.control\.sock$/i.exec(name);
    if (!m) continue;
    const pid = Number(m[1]);
    if (Number.isInteger(pid) && pid > 0) result.add(pid);
  }
  return result;
}

function mojoPipeName(pid: number, suffix: string, runtimeDir = resolveHookRuntimeDir(pid)): string {
  if (process.platform === 'win32') {
    return `\\\\.\\pipe\\mojo.${pid}.${suffix}`;
  }
  return path.join(runtimeDir, `mojo.${pid}.${suffix}.sock`);
}

type LinuxPipeProbe = (socketPath: string) => Promise<boolean>;

async function isConnectableUnixSocket(socketPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(socketPath);
    if (!stat.isSocket()) return false;
  } catch (error) {
    if (isUnavailableSocketError(error)) return false;
    throw error;
  }

  return new Promise<boolean>((resolve, reject) => {
    let socket: net.Socket;
    try {
      socket = net.createConnection(socketPath);
    } catch (error) {
      if (isUnavailableSocketError(error)) resolve(false);
      else reject(error);
      return;
    }
    let done = false;
    let timer: NodeJS.Timeout;
    const finish = (ok: boolean) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      socket.destroy();
      resolve(ok);
    };
    timer = setTimeout(() => finish(false), DEFAULT_PIPE_PROBE_TIMEOUT_MS);
    socket.once('connect', () => finish(true));
    socket.once('error', error => {
      if (isUnavailableSocketError(error)) finish(false);
      else {
        if (done) return;
        done = true;
        clearTimeout(timer);
        socket.removeAllListeners();
        socket.destroy();
        reject(error);
      }
    });
  });
}

export async function listLiveLinuxPipePids(
  runtimeDir = resolveHookRuntimeDir(),
  probe: LinuxPipeProbe = isConnectableUnixSocket,
): Promise<Set<number>> {
  const result = new Set<number>();
  let names: string[];
  try {
    names = await fs.readdir(runtimeDir);
  } catch (error) {
    if (isMissingDirectoryError(error)) return result;
    throw error;
  }

  await Promise.all(names.map(async (name) => {
    const m = /^mojo\.(\d+)\.control\.sock$/.exec(name);
    if (!m) return;
    const pid = Number(m[1]);
    if (!Number.isInteger(pid) || pid <= 0) return;
    if (await probe(path.join(runtimeDir, name))) result.add(pid);
  }));

  return result;
}

function toBuffer(body: Buffer | Uint8Array | string | null | undefined): Buffer {
  if (Buffer.isBuffer(body)) return body;
  if (body instanceof Uint8Array) return Buffer.from(body);
  if (typeof body === 'string') return Buffer.from(body, 'utf8');
  if (body == null) return Buffer.alloc(0);
  throw new TypeError('body must be Buffer, Uint8Array, string, or null');
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

class OperationTimeoutError extends Error {
  constructor(
    readonly label: string,
    timeoutMs: number,
  ) {
    super(`${label} timed out after ${timeoutMs} ms`);
    this.name = 'OperationTimeoutError';
  }
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, label: string): Promise<T> {
  if (!timeoutMs || timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new OperationTimeoutError(label, timeoutMs));
    }, timeoutMs);
    promise.then(
      value => {
        clearTimeout(timer);
        resolve(value);
      },
      error => {
        clearTimeout(timer);
        reject(error);
      });
  });
}

class HookPipeRequestError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'HookPipeRequestError';
  }
}

function packetFailureReason(
  error: unknown,
  requestId: number,
): 'ack_timeout' | 'reply_timeout' | 'request_failed' | 'transport_failure' {
  if (error instanceof HookPipeRequestError) return 'request_failed';
  if (error instanceof OperationTimeoutError) {
    if (error.label === `send ack ${requestId}`) return 'ack_timeout';
    if (error.label === `send reply ${requestId}`) return 'reply_timeout';
  }
  return 'transport_failure';
}

function encodeFrame({
  op,
  requestId = 0,
  status = 0,
  flags = 0,
  value0 = 0n,
  cmd = '',
  msg = '',
  body = Buffer.alloc(0),
}: {
  op: number;
  requestId?: number;
  status?: number;
  flags?: number;
  value0?: bigint | number;
  cmd?: string;
  msg?: string;
  body?: Buffer | Uint8Array | string | null;
}): Buffer {
  const cmdBuf = Buffer.from(cmd, 'utf8');
  const msgBuf = Buffer.from(msg, 'utf8');
  const bodyBuf = toBuffer(body);
  validatePipeFrameLengths(cmdBuf.length, msgBuf.length, bodyBuf.length);
  const header = Buffer.alloc(HEADER_SIZE);
  header.writeUInt32LE(PIPE_MAGIC, 0);
  header.writeUInt16LE(PIPE_VERSION, 4);
  header.writeUInt16LE(op, 6);
  header.writeUInt32LE(requestId >>> 0, 8);
  header.writeInt32LE(status | 0, 12);
  header.writeUInt32LE(flags >>> 0, 16);
  header.writeUInt32LE(cmdBuf.length >>> 0, 20);
  header.writeUInt32LE(msgBuf.length >>> 0, 24);
  header.writeUInt32LE(bodyBuf.length >>> 0, 28);
  header.writeBigUInt64LE(BigInt(value0), 32);
  return Buffer.concat([header, cmdBuf, msgBuf, bodyBuf]);
}

function validatePipeFrameLengths(cmdLen: number, msgLen: number, bodyLen: number): void {
  const lengths = [
    ['command', cmdLen, MAX_PIPE_CMD_BYTES],
    ['message', msgLen, MAX_PIPE_MSG_BYTES],
    ['body', bodyLen, MAX_PIPE_BODY_BYTES],
  ] as const;
  for (const [name, length, limit] of lengths) {
    if (length > limit) {
      throw new Error(`pipe frame ${name} length ${length} exceeds limit ${limit}`);
    }
  }
}

interface PendingPipeFrame {
  op: number;
  requestId: number;
  status: number;
  flags: number;
  value0: bigint;
  cmdLen: number;
  msgLen: number;
  bodyLen: number;
  payload: Buffer;
  received: number;
}

class FrameReader {
  private readonly header = Buffer.alloc(HEADER_SIZE);
  private headerBytes = 0;
  private pending: PendingPipeFrame | null = null;

  constructor(private readonly onFrame: (frame: PipeFrame) => void) { }

  push(chunk: Buffer): void {
    let chunkOffset = 0;
    while (chunkOffset < chunk.length) {
      if (!this.pending) {
        const headerBytes = Math.min(HEADER_SIZE - this.headerBytes, chunk.length - chunkOffset);
        chunk.copy(
          this.header,
          this.headerBytes,
          chunkOffset,
          chunkOffset + headerBytes,
        );
        this.headerBytes += headerBytes;
        chunkOffset += headerBytes;
        if (this.headerBytes < HEADER_SIZE) return;

        this.headerBytes = 0;
        const magic = this.header.readUInt32LE(0);
        const version = this.header.readUInt16LE(4);
        if (magic !== PIPE_MAGIC || version !== PIPE_VERSION) {
          throw new Error(`bad frame header magic=0x${magic.toString(16)} version=${version}`);
        }

        const cmdLen = this.header.readUInt32LE(20);
        const msgLen = this.header.readUInt32LE(24);
        const bodyLen = this.header.readUInt32LE(28);
        validatePipeFrameLengths(cmdLen, msgLen, bodyLen);
        const payloadLength = cmdLen + msgLen + bodyLen;
        this.pending = {
          op: this.header.readUInt16LE(6),
          requestId: this.header.readUInt32LE(8),
          status: this.header.readInt32LE(12),
          flags: this.header.readUInt32LE(16),
          value0: this.header.readBigUInt64LE(32),
          cmdLen,
          msgLen,
          bodyLen,
          payload: payloadLength === 0 ? Buffer.alloc(0) : Buffer.allocUnsafe(payloadLength),
          received: 0,
        };
      }

      const pending = this.pending;
      const payloadBytes = Math.min(
        pending.payload.length - pending.received,
        chunk.length - chunkOffset,
      );
      if (payloadBytes > 0) {
        chunk.copy(
          pending.payload,
          pending.received,
          chunkOffset,
          chunkOffset + payloadBytes,
        );
        pending.received += payloadBytes;
        chunkOffset += payloadBytes;
      }
      if (pending.received < pending.payload.length) return;

      this.pending = null;
      const frame: PipeFrame = {
        op: pending.op,
        requestId: pending.requestId,
        status: pending.status,
        flags: pending.flags,
        value0: pending.value0,
        cmd: '',
        msg: '',
        body: Buffer.alloc(0),
      };

      let offset = 0;
      frame.cmd = pending.payload.subarray(offset, offset + pending.cmdLen).toString('utf8');
      offset += pending.cmdLen;
      frame.msg = pending.payload.subarray(offset, offset + pending.msgLen).toString('utf8');
      offset += pending.msgLen;
      frame.body = Buffer.from(pending.payload.subarray(offset, offset + pending.bodyLen));
      this.onFrame(frame);
    }
  }
}

export class QqHookClient extends EventEmitter {
  readonly pid: number;
  readonly runtimeDir: string;
  readonly defaultAckTimeoutMs: number;
  readonly defaultReplyTimeoutMs: number;

  private controlSocket: net.Socket | null = null;
  private recvSocket: net.Socket | null = null;
  private controlConnectPromise: Promise<QqHookHello> | null = null;
  private recvConnectPromise: Promise<QqHookHello> | null = null;
  private nextRequestId = 1;
  private pendingAcks = new Map<number, PendingAck>();
  private pendingReplies = new Map<number, Deferred<QqHookSendReply>>();
  private controlHello: QqHookHello | null = null;
  private recvHello: QqHookHello | null = null;
  private controlHelloResolver: Deferred<QqHookHello> | null = null;
  private recvHelloResolver: Deferred<QqHookHello> | null = null;
  private controlWriteChain: Promise<unknown> = Promise.resolve();
  private closed = false;
  private loginState: QqHookLoginState = { loggedIn: false, uin: '0', uinNumber: 0n };
  private loginWaiters: Deferred<QqHookLoginState>[] = [];

  constructor(pid: number, {
    ackTimeoutMs = DEFAULT_ACK_TIMEOUT_MS,
    replyTimeoutMs = DEFAULT_REPLY_TIMEOUT_MS,
    runtimeDir = resolveHookRuntimeDir(pid),
  }: QqHookClientOptions = {}) {
    super();
    this.pid = pid;
    this.runtimeDir = runtimeDir;
    this.defaultAckTimeoutMs = ackTimeoutMs;
    this.defaultReplyTimeoutMs = replyTimeoutMs;
  }

  get isLoggedIn(): boolean {
    return this.loginState.loggedIn;
  }

  get isClosed(): boolean {
    return this.closed;
  }

  get currentUin(): string {
    return this.loginState.uin;
  }

  get currentUinNumber(): bigint {
    return this.loginState.uinNumber;
  }

  getLoginState(): QqHookLoginState {
    return { ...this.loginState };
  }

  /**
   * Forward an observed account identity for reconciliation. This does not
   * change login state; readiness still requires peer confirmation.
   */
  async reconcileLoginIdentity(uin: string): Promise<void> {
    if (!isRealUin(uin)) {
      throw new Error(`invalid QQ login identity hint: ${JSON.stringify(uin)}`);
    }
    await this.sendAckOnly(PipeOp.loginIdentityHint, BigInt(uin), 'login identity hint');
  }

  async waitForLogin({ timeoutMs = 0 } = {}): Promise<QqHookLoginState> {
    await this.connect();
    if (this.loginState.loggedIn) {
      return this.getLoginState();
    }
    const deferred = createDeferred<QqHookLoginState>();
    this.loginWaiters.push(deferred);
    return withTimeout(deferred.promise, timeoutMs, 'waitForLogin');
  }

  static controlPipeName(pid: number, runtimeDir = resolveHookRuntimeDir(pid)): string {
    return mojoPipeName(pid, 'control', runtimeDir);
  }

  static recvPipeName(pid: number, runtimeDir = resolveHookRuntimeDir(pid)): string {
    return mojoPipeName(pid, 'recv', runtimeDir);
  }

  /**
   * Lightweight liveness check for the control pipe. Used to detect whether an
   * existing SnowLuma hook is still hosted inside the QQ.exe process without
   * opening the pipe, so probing cannot disturb the first real client connect.
   */
  static async probePipe(pid: number): Promise<boolean> {
    const live = await QqHookClient.listLivePipes([pid]);
    return live.has(pid);
  }

  /**
   * Enumerate every PID currently hosting a SnowLuma `mojo.<pid>.control` pipe
   * in a single filesystem listing. The HookManager's pipe-watcher uses this
   * to drive connect/reconnect decisions without per-PID stat calls.
   */
  static async listLivePipes(pids: readonly number[] = []): Promise<Set<number>> {
    const result = new Set<number>();
    if (process.platform === 'win32') {
      const names = await fs.readdir('\\\\.\\pipe\\');
      for (const name of names) {
        const m = /^mojo\.(\d+)\.control$/i.exec(name);
        if (m) result.add(Number(m[1]));
      }
    } else {
      const runtimeDirs = new Set<string>();
      if (pids.length === 0) {
        runtimeDirs.add(resolveHookRuntimeDir());
      } else {
        for (const pid of pids) runtimeDirs.add(resolveHookRuntimeDir(pid));
      }
      for (const runtimeDir of runtimeDirs) {
        for (const pid of await listLiveLinuxPipePids(runtimeDir)) result.add(pid);
      }
    }
    return result;
  }

  async connect(): Promise<QqHookHello> {
    if (this.closed) {
      throw new Error('qq_hook client is closed');
    }
    if (this.controlSocket && this.controlHello) {
      return this.controlHello;
    }
    if (this.controlConnectPromise) {
      return this.controlConnectPromise;
    }
    this.controlConnectPromise = this.connectPipe('control');
    try {
      return await this.controlConnectPromise;
    } finally {
      this.controlConnectPromise = null;
    }
  }

  async startRecv(onPacket?: (packet: QqHookPacket) => void): Promise<QqHookHello> {
    if (this.closed) {
      throw new Error('qq_hook client is closed');
    }
    if (typeof onPacket === 'function') {
      this.on('packet', onPacket);
    }
    if (this.recvSocket && this.recvHello) {
      return this.recvHello;
    }
    if (this.recvConnectPromise) {
      return this.recvConnectPromise;
    }
    this.recvConnectPromise = this.connectPipe('recv');
    try {
      return await this.recvConnectPromise;
    } finally {
      this.recvConnectPromise = null;
    }
  }

  async connectAll({ recv = true } = {}): Promise<{ control: QqHookHello; recv: QqHookHello | null }> {
    const control = await this.connect();
    const recvInfo = recv ? await this.startRecv() : null;
    return { control, recv: recvInfo };
  }

  async send(cmd: string, body: Buffer | Uint8Array | string | null | undefined, {
    wantReply = true,
    ackTimeoutMs = this.defaultAckTimeoutMs,
    replyTimeoutMs = this.defaultReplyTimeoutMs,
  }: QqHookSendOptions = {}): Promise<QqHookSendReply | { requestId: number }> {
    await this.connect();

    const requestId = this.allocateRequestId();
    const startedAt = Date.now();
    const bodyBytes = toBuffer(body);
    const payload = encodeFrame({
      op: PipeOp.sendRequest,
      requestId,
      flags: wantReply ? PipeFlagWantReply : 0,
      cmd,
      body: bodyBytes,
    });
    packetLog.trace(() => [
      'packet_send serviceCmd=%j requestId=%d length=%d body=%s',
      cmd,
      requestId,
      bodyBytes.length,
      renderTraceBytes(bodyBytes),
    ]);

    const ackDeferred = createDeferred<{ requestId: number; wantReply: boolean }>();
    // Always attach a handler so a rejection can never become "unhandled" (which
    // crashes Node). When the pipe closes, rejectControlPending() rejects every
    // pending deferred — but the reply is only `await`ed AFTER the ack, so if the
    // ack fails first the reply promise is rejected with NO awaiter. The real
    // `await` below still observes the value/rejection (a separate continuation).
    ackDeferred.promise.catch(() => { /* observed by the await, or harmless */ });
    this.pendingAcks.set(requestId, {
      resolve: ackDeferred.resolve,
      reject: ackDeferred.reject,
      wantReply,
    });

    let replyDeferred: Deferred<QqHookSendReply> | null = null;
    if (wantReply) {
      replyDeferred = createDeferred<QqHookSendReply>();
      replyDeferred.promise.catch(() => { /* see note above — prevents unhandled rejection */ });
      this.pendingReplies.set(requestId, replyDeferred);
    }

    try {
      await this.writeControl(payload);
      await withTimeout(ackDeferred.promise, ackTimeoutMs, `send ack ${requestId}`);
      if (!wantReply) {
        packetLog.trace(() => [
          'packet_terminal serviceCmd=%j requestId=%d outcome=ok reason=ack_received elapsedMs=%d',
          cmd,
          requestId,
          Date.now() - startedAt,
        ]);
        return { requestId };
      }
      const reply = await withTimeout(
        replyDeferred!.promise,
        replyTimeoutMs,
        `send reply ${requestId}`);
      packetLog.trace(() => [
        'packet_recv serviceCmd=%j requestId=%d error=%d message=%j length=%d body=%s',
        cmd,
        requestId,
        reply.error,
        reply.message,
        reply.body.length,
        renderTraceBytes(reply.body),
      ]);
      packetLog.trace(() => [
        'packet_terminal serviceCmd=%j requestId=%d outcome=%s reason=%s error=%d elapsedMs=%d',
        cmd,
        requestId,
        reply.error === 0 ? 'ok' : 'failed',
        reply.error === 0 ? 'reply_received' : 'reply_error',
        reply.error,
        Date.now() - startedAt,
      ]);
      return reply;
    } catch (error) {
      this.pendingAcks.delete(requestId);
      this.pendingReplies.delete(requestId);
      const reason = packetFailureReason(error, requestId);
      packetLog.trace(() => [
        'packet_terminal serviceCmd=%j requestId=%d outcome=%s reason=%s error=%j elapsedMs=%d',
        cmd,
        requestId,
        reason.endsWith('_timeout') ? 'timeout' : 'failed',
        reason,
        error instanceof Error ? error.message : String(error),
        Date.now() - startedAt,
      ]);
      throw error;
    }
  }

  async sendNoReply(cmd: string, body: Buffer | Uint8Array | string | null | undefined, options: Omit<QqHookSendOptions, 'wantReply'> = {}): Promise<{ requestId: number }> {
    return this.send(cmd, body, { ...options, wantReply: false }) as Promise<{ requestId: number }>;
  }

  async sendAndWait(cmd: string, body: Buffer | Uint8Array | string | null | undefined, options: Omit<QqHookSendOptions, 'wantReply'> = {}): Promise<QqHookSendReply> {
    return this.send(cmd, body, { ...options, wantReply: true }) as Promise<QqHookSendReply>;
  }

  async sendMany(items: Array<{ cmd: string; body?: Buffer | Uint8Array | string | null; wantReply?: boolean; ackTimeoutMs?: number; replyTimeoutMs?: number }>, {
    concurrency = 64,
    wantReply = true,
    ackTimeoutMs = this.defaultAckTimeoutMs,
    replyTimeoutMs = this.defaultReplyTimeoutMs,
  }: QqHookSendOptions & { concurrency?: number } = {}): Promise<Array<QqHookSendReply | { requestId: number }>> {
    const results = new Array<QqHookSendReply | { requestId: number }>(items.length);
    let nextIndex = 0;
    const workerCount = Math.max(1, Math.min(concurrency | 0, items.length || 1));

    const worker = async () => {
      for (; ;) {
        const index = nextIndex;
        nextIndex += 1;
        if (index >= items.length) return;
        const item = items[index];
        const itemWantReply = item.wantReply ?? wantReply;
        results[index] = await this.send(item.cmd, item.body, {
          wantReply: itemWantReply,
          ackTimeoutMs: item.ackTimeoutMs ?? ackTimeoutMs,
          replyTimeoutMs: item.replyTimeoutMs ?? replyTimeoutMs,
        });
      }
    };

    await Promise.all(Array.from({ length: workerCount }, () => worker()));
    return results;
  }

  waitForPacket(predicate: (packet: QqHookPacket) => boolean = () => true, { timeoutMs = 0 } = {}): Promise<QqHookPacket> {
    return new Promise((resolve, reject) => {
      let timer: NodeJS.Timeout | null = null;
      const cleanup = () => {
        this.off('packet', onPacket);
        if (timer) {
          clearTimeout(timer);
          timer = null;
        }
      };
      const onPacket = (packet: QqHookPacket) => {
        try {
          if (!predicate(packet)) return;
          cleanup();
          resolve(packet);
        } catch (error) {
          cleanup();
          reject(error);
        }
      };
      this.on('packet', onPacket);
      if (timeoutMs > 0) {
        timer = setTimeout(() => {
          cleanup();
          reject(new Error(`recv packet timed out after ${timeoutMs} ms`));
        }, timeoutMs);
      }
    });
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.rejectControlPending(new Error('qq_hook client closed'));
    this.rejectRecvPending(new Error('qq_hook client closed'));
    this.rejectLoginWaiters(new Error('qq_hook client closed'));

    if (this.controlSocket) {
      this.controlSocket.destroy();
      this.controlSocket = null;
    }
    if (this.recvSocket) {
      this.recvSocket.destroy();
      this.recvSocket = null;
    }
    this.controlHello = null;
    this.recvHello = null;
    this.controlWriteChain = Promise.resolve();
  }

  private rejectLoginWaiters(error: Error): void {
    const waiters = this.loginWaiters;
    this.loginWaiters = [];
    for (const waiter of waiters) waiter.reject(error);
  }

  private rejectControlPending(error: Error): void {
    for (const pending of this.pendingAcks.values()) {
      pending.reject(error);
    }
    for (const pending of this.pendingReplies.values()) {
      pending.reject(error);
    }
    this.pendingAcks.clear();
    this.pendingReplies.clear();
    if (this.controlHelloResolver) {
      this.controlHelloResolver.reject(error);
      this.controlHelloResolver = null;
    }
  }

  private rejectRecvPending(error: Error): void {
    if (this.recvHelloResolver) {
      this.recvHelloResolver.reject(error);
      this.recvHelloResolver = null;
    }
  }

  private writeControl(payload: Buffer): Promise<void> {
    const socket = this.controlSocket;
    if (!socket || socket.destroyed) {
      return Promise.reject(new Error('control pipe is not connected'));
    }
    const writePromise = this.controlWriteChain.then(() => new Promise<void>((resolve, reject) => {
      if (!this.controlSocket || this.controlSocket.destroyed) {
        reject(new Error('control pipe is not connected'));
        return;
      }
      socket.write(payload, error => {
        if (error) reject(error);
        else resolve();
      });
    }));
    this.controlWriteChain = writePromise.catch(() => { });
    return writePromise;
  }

  private allocateRequestId(): number {
    // Wrap inside uint32 explicitly. `nextRequestId++ >>> 0` would lose
    // precision past Number.MAX_SAFE_INTEGER. Zero remains the wire sentinel.
    let requestId = this.nextRequestId;
    while (this.pendingAcks.has(requestId) || this.pendingReplies.has(requestId)) {
      requestId = (requestId + 1) >>> 0;
      if (requestId === 0) requestId = 1;
    }
    this.nextRequestId = (requestId + 1) >>> 0;
    if (this.nextRequestId === 0) this.nextRequestId = 1;
    return requestId;
  }

  private async sendAckOnly(op: PipeOp, value0: bigint, label: string): Promise<number> {
    await this.connect();
    const requestId = this.allocateRequestId();
    const ackDeferred = createDeferred<{ requestId: number; wantReply: boolean }>();
    ackDeferred.promise.catch(() => { /* observed by the await below */ });
    this.pendingAcks.set(requestId, {
      resolve: ackDeferred.resolve,
      reject: ackDeferred.reject,
      wantReply: false,
    });
    try {
      await this.writeControl(encodeFrame({ op, requestId, value0 }));
      await withTimeout(
        ackDeferred.promise,
        this.defaultAckTimeoutMs,
        `${label} ack ${requestId}`,
      );
      return requestId;
    } catch (error) {
      this.pendingAcks.delete(requestId);
      throw error;
    }
  }

  private async connectPipe(kind: 'control' | 'recv'): Promise<QqHookHello> {
    return runWithTraceRequest(async () => {
      const startedAt = Date.now();
      const pipeName = kind === 'control'
        ? QqHookClient.controlPipeName(this.pid, this.runtimeDir)
        : QqHookClient.recvPipeName(this.pid, this.runtimeDir);
      let phase: 'connect' | 'hello' = 'connect';
      runtimeLog.trace(
        'hook_pipe_start pid=%d kind=%s pipeName=%j',
        this.pid,
        kind,
        pipeName,
      );
      try {
        const socket = await runWithoutRequestContext(() => this.connectSocket(
          pipeName,
          kind,
          kind === 'control'
            ? frame => this.handleControlFrame(frame)
            : frame => this.handleRecvFrame(frame),
        ));
        if (kind === 'control') this.controlSocket = socket;
        else this.recvSocket = socket;
        runtimeLog.trace(
          'hook_pipe_branch pid=%d kind=%s branch=socket_connected',
          this.pid,
          kind,
        );
        phase = 'hello';
        const hello = await this.waitForHello(kind === 'recv');
        if (kind === 'control') this.controlHello = hello;
        else this.recvHello = hello;
        runtimeLog.trace(() => [
          'hook_pipe_terminal pid=%d kind=%s outcome=completed reason=hello_received hello=%s elapsedMs=%d',
          this.pid,
          kind,
          renderParamsVerbose(hello),
          Date.now() - startedAt,
        ]);
        return hello;
      } catch (error) {
        runtimeLog.trace(() => [
          'hook_pipe_terminal pid=%d kind=%s outcome=failed reason=%s error=%j elapsedMs=%d',
          this.pid,
          kind,
          phase === 'connect' ? 'connect_failed' : 'hello_failed',
          error instanceof Error ? error.message : String(error),
          Date.now() - startedAt,
        ]);
        throw error;
      }
    });
  }

  private connectSocket(pipeName: string, kind: 'control' | 'recv', onFrame: (frame: PipeFrame) => void): Promise<net.Socket> {
    return new Promise((resolve, reject) => {
      const socket = net.createConnection(pipeName);
      const reader = new FrameReader(onFrame);
      const onInitialError = (error: Error) => reject(error);
      socket.once('error', onInitialError);
      socket.once('connect', () => {
        socket.off('error', onInitialError);
        socket.on('data', chunk => {
          try {
            reader.push(chunk);
          } catch (error) {
            this.emit('error', error);
            socket.destroy();
          }
        });
        socket.on('error', error => {
          this.emit('error', error);
        });
        socket.on('close', () => {
          runWithTraceRequest(() => {
            this.handleSocketClose(kind);
            this.emit('close', kind);
          });
        });
        resolve(socket);
      });
    });
  }

  private waitForHello(recvPipe: boolean): Promise<QqHookHello> {
    const deferred = createDeferred<QqHookHello>();
    if (recvPipe) {
      this.recvHelloResolver = deferred;
    } else {
      this.controlHelloResolver = deferred;
    }
    return deferred.promise;
  }

  private resolveHello(frame: PipeFrame, recvPipe: boolean): void {
    const resolver = recvPipe ? this.recvHelloResolver : this.controlHelloResolver;
    if (!resolver) return;
    if (recvPipe) this.recvHelloResolver = null;
    else this.controlHelloResolver = null;
    resolver.resolve({
      pipeName: frame.msg,
      pid: Number(frame.value0),
      recvPipe,
    });
  }

  private handleSocketClose(kind: 'control' | 'recv'): void {
    runtimeLog.trace(
      'hook_runtime_fact pid=%d event=pipe_closed kind=%s loggedIn=%s uin=%j',
      this.pid,
      kind,
      this.loginState.loggedIn,
      this.loginState.uin,
    );
    if (kind === 'control') {
      this.controlSocket = null;
      this.controlHello = null;
      this.rejectControlPending(new Error('control pipe closed'));
      return;
    }
    this.recvSocket = null;
    this.recvHello = null;
    this.rejectRecvPending(new Error('recv pipe closed'));
  }

  private applyLoginStateFrame(frame: PipeFrame): void {
    const flaggedLoggedIn = (frame.flags & PipeFlagLoggedIn) !== 0;
    const statusLoggedIn = frame.status !== 0;
    const loggedIn = flaggedLoggedIn || statusLoggedIn;
    const uinNumber = BigInt(frame.value0);
    const uin = frame.msg || uinNumber.toString();
    this.applyLoginState({ loggedIn, uin, uinNumber });
  }

  private applyLoginState(next: QqHookLoginState): void {
    const previous = this.loginState;
    this.loginState = next;
    if (previous.loggedIn === next.loggedIn && previous.uin === next.uin) {
      this.emit('loginState', next);
      return;
    }
    runWithTraceRequest(() => {
      runtimeLog.trace(
        'hook_runtime_fact pid=%d event=login_state_changed previousLoggedIn=%s previousUin=%j loggedIn=%s uin=%j',
        this.pid,
        previous.loggedIn,
        previous.uin,
        next.loggedIn,
        next.uin,
      );
      this.emit('loginState', next);
      if (next.loggedIn) {
        const waiters = this.loginWaiters;
        this.loginWaiters = [];
        for (const waiter of waiters) waiter.resolve({ ...next });
      }
    });
  }

  private handleControlFrame(frame: PipeFrame): void {
    if (frame.op === PipeOp.hello) {
      this.resolveHello(frame, false);
      return;
    }
    if (frame.op === PipeOp.loginState) {
      this.applyLoginStateFrame(frame);
      return;
    }
    if (frame.op === PipeOp.sendAck) {
      const pending = this.pendingAcks.get(frame.requestId);
      if (!pending) return;
      this.pendingAcks.delete(frame.requestId);
      pending.resolve({ requestId: frame.requestId, wantReply: pending.wantReply });
      return;
    }
    if (frame.op === PipeOp.sendReply) {
      const pending = this.pendingReplies.get(frame.requestId);
      if (!pending) return;
      this.pendingReplies.delete(frame.requestId);
      pending.resolve({
        requestId: frame.requestId,
        error: frame.status,
        message: frame.msg,
        body: Buffer.from(frame.body),
      });
      return;
    }
    if (frame.op === PipeOp.error) {
      const error = new HookPipeRequestError(frame.msg || `pipe error ${frame.status}`);
      const ack = this.pendingAcks.get(frame.requestId);
      if (ack) {
        this.pendingAcks.delete(frame.requestId);
        ack.reject(error);
      }
      const reply = this.pendingReplies.get(frame.requestId);
      if (reply) {
        this.pendingReplies.delete(frame.requestId);
        reply.reject(error);
      }
    }
  }

  private handleRecvFrame(frame: PipeFrame): void {
    if (frame.op === PipeOp.hello) {
      this.resolveHello(frame, true);
      return;
    }
    if (frame.op === PipeOp.loginState) {
      this.applyLoginStateFrame(frame);
      return;
    }
    if (frame.op !== PipeOp.recvPacket) return;
    this.emit('packet', {
      seq: Number(frame.value0),
      error: frame.status,
      cmd: frame.cmd,
      uin: frame.msg,
      body: Buffer.from(frame.body),
    } satisfies QqHookPacket);
  }
}

export { mojoPipeName };
