import { EventEmitter } from 'events';
import { spawn } from 'child_process';
import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';

export interface ProtocolHostProcess extends EventEmitter {
  readonly stdout: EventEmitter;
  readonly stderr: EventEmitter;
  readonly stdin: { write(chunk: string): boolean };
  kill(signal?: NodeJS.Signals): boolean;
}

interface PendingRequest {
  resolve(result: SendPacketResult): void;
  timer: NodeJS.Timeout;
}

type HostMessage = Record<string, unknown>;

export interface ProtocolHostClientOptions {
  executable: string;
  dataDir: string;
}

export class ProtocolHostClient extends EventEmitter implements PacketSender {
  private buffer = '';
  private nextRequestId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  private closed = false;

  constructor(private readonly process: ProtocolHostProcess) {
    super();
    process.stdout.on('data', (chunk: Buffer | string) => this.onStdout(chunk));
    process.stderr.on('data', (chunk: Buffer | string) => {
      const message = String(chunk).trim();
      if (message) this.emit('log', { level: 'warning', message });
    });
    process.once('error', (error: Error) => {
      this.closePending(error.message);
      this.emit('host_error', { message: error.message });
    });
    process.once('exit', (code: number | null, signal: NodeJS.Signals | null) => {
      const suffix = signal ? `signal ${signal}` : `code ${code ?? 'unknown'}`;
      this.closePending(`protocol host exited with ${suffix}`);
      this.emit('exit', { code, signal });
    });
  }

  static spawn(options: ProtocolHostClientOptions): ProtocolHostClient {
    const child = spawn(options.executable, ['--data-dir', options.dataDir], {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    return new ProtocolHostClient(child as unknown as ProtocolHostProcess);
  }

  async start(): Promise<void> {
    if (this.closed) throw new Error('protocol host is closed');
    this.write({ action: 'start' });
  }

  async stop(): Promise<void> {
    if (this.closed) return;
    this.write({ action: 'stop' });
    this.closed = true;
    this.process.kill();
    this.closePending('protocol session stopped');
  }

  sendPacket(serviceCmd: string, body: Buffer, timeoutMs = 15_000): Promise<SendPacketResult> {
    if (this.closed) return Promise.resolve(failedResult('protocol host is closed'));

    const id = this.nextRequestId++;
    return new Promise<SendPacketResult>((resolve) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        resolve(failedResult(`protocol request timed out after ${timeoutMs} ms`));
      }, timeoutMs);
      timer.unref?.();
      this.pending.set(id, { resolve, timer });
      this.write({
        id,
        action: 'send',
        command: serviceCmd,
        bodyBase64: body.toString('base64'),
      });
    });
  }

  private write(message: HostMessage): void {
    this.process.stdin.write(`${JSON.stringify(message)}\n`);
  }

  private onStdout(chunk: Buffer | string): void {
    this.buffer += String(chunk);
    while (true) {
      const newline = this.buffer.indexOf('\n');
      if (newline < 0) return;
      const line = this.buffer.slice(0, newline).replace(/\r$/, '');
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      try {
        this.onMessage(JSON.parse(line) as HostMessage);
      } catch (error) {
        this.emit('log', {
          level: 'warning',
          message: `invalid protocol host frame: ${error instanceof Error ? error.message : String(error)}`,
        });
      }
    }
  }

  private onMessage(message: HostMessage): void {
    if (typeof message.id === 'number') {
      const pending = this.pending.get(message.id);
      if (!pending) return;
      this.pending.delete(message.id);
      clearTimeout(pending.timer);
      const success = message.ok === true;
      pending.resolve({
        success,
        gotResponse: success || typeof message.retCode === 'number',
        errorCode: typeof message.retCode === 'number' ? message.retCode : success ? 0 : -1,
        errorMessage: typeof message.error === 'string' ? message.error : '',
        responseData: typeof message.bodyBase64 === 'string'
          ? Buffer.from(message.bodyBase64, 'base64')
          : success ? Buffer.alloc(0) : null,
      });
      return;
    }

    switch (message.event) {
      case 'qrcode':
        if (typeof message.url === 'string' && typeof message.imageBase64 === 'string') {
          this.emit('qrcode', { url: message.url, image: Buffer.from(message.imageBase64, 'base64') });
        }
        break;
      case 'qrcode_state':
        if (typeof message.state === 'string') this.emit('qrcode_state', { state: message.state });
        break;
      case 'online':
        if (typeof message.uin === 'string') this.emit('online', { uin: message.uin });
        break;
      case 'offline':
        this.emit('offline', { reason: typeof message.reason === 'string' ? message.reason : '' });
        break;
      case 'packet':
        if (typeof message.command === 'string' && typeof message.bodyBase64 === 'string') {
          this.emit('packet', {
            command: message.command,
            sequence: typeof message.sequence === 'number' ? message.sequence : 0,
            retCode: typeof message.retCode === 'number' ? message.retCode : 0,
            body: Buffer.from(message.bodyBase64, 'base64'),
          });
        }
        break;
      case 'error':
        this.emit('host_error', { message: typeof message.message === 'string' ? message.message : 'protocol host error' });
        break;
      case 'log':
        this.emit('log', message);
        break;
    }
  }

  private closePending(message: string): void {
    if (!this.closed) this.closed = true;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timer);
      pending.resolve(failedResult(message));
    }
    this.pending.clear();
  }
}

function failedResult(message: string): SendPacketResult {
  return {
    success: false,
    gotResponse: false,
    errorCode: -1,
    errorMessage: message,
    responseData: null,
  };
}
