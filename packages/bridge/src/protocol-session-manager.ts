import { randomUUID } from 'crypto';
import { EventEmitter } from 'events';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';

export type ProtocolSessionStatus =
  | 'starting'
  | 'waiting_scan'
  | 'waiting_confirm'
  | 'online'
  | 'error'
  | 'disconnected';

export interface ProtocolSessionInfo {
  id: string;
  status: ProtocolSessionStatus;
  uin: string;
  qrCodeUrl: string;
  error: string;
}

export interface ProtocolHost extends EventEmitter, PacketSender {
  start(): Promise<void>;
  stop(): Promise<void>;
}

export interface ProtocolBridgeSink {
  onHookLogin(pid: number, uin: string, packetClient: PacketSender): void;
  onPidDisconnected(pid: number): void;
  onPacket(packet: PacketInfo): void;
}

interface ProtocolSession extends ProtocolSessionInfo {
  host: ProtocolHost;
  syntheticPid: number;
  qrCodeImage: Buffer | null;
  bound: boolean;
}

export interface ProtocolSessionManagerDeps {
  bridgeManager: ProtocolBridgeSink;
  createHost(id: string): ProtocolHost;
  createId?: () => string;
  onSessionsChanged?: () => void;
}

export class ProtocolSessionManager {
  private readonly sessions = new Map<string, ProtocolSession>();
  private readonly createId: () => string;
  private nextSyntheticPid = -1;

  constructor(private readonly deps: ProtocolSessionManagerDeps) {
    this.createId = deps.createId ?? randomUUID;
  }

  listSessions(): ProtocolSessionInfo[] {
    return [...this.sessions.values()].map(toPublicInfo);
  }

  getSession(id: string): ProtocolSessionInfo | null {
    const session = this.sessions.get(id);
    return session ? toPublicInfo(session) : null;
  }

  getQrCode(id: string): Buffer | null {
    const image = this.sessions.get(id)?.qrCodeImage;
    return image ? Buffer.from(image) : null;
  }

  async startSession(): Promise<ProtocolSessionInfo> {
    const id = this.createId();
    const host = this.deps.createHost(id);
    const session: ProtocolSession = {
      id,
      host,
      syntheticPid: this.nextSyntheticPid--,
      status: 'starting',
      uin: '',
      qrCodeUrl: '',
      qrCodeImage: null,
      error: '',
      bound: false,
    };
    this.sessions.set(id, session);
    this.bindHost(session);
    this.notify();

    try {
      await host.start();
    } catch (error) {
      session.status = 'error';
      session.error = error instanceof Error ? error.message : String(error);
      this.notify();
    }
    return toPublicInfo(session);
  }

  async stopSession(id: string): Promise<boolean> {
    const session = this.sessions.get(id);
    if (!session) return false;
    this.disconnectBridge(session);
    this.sessions.delete(id);
    this.notify();
    await session.host.stop();
    return true;
  }

  dispose(): void {
    for (const session of [...this.sessions.values()]) {
      this.disconnectBridge(session);
      void session.host.stop();
    }
    this.sessions.clear();
    this.notify();
  }

  private bindHost(session: ProtocolSession): void {
    session.host.on('qrcode', (event: { url: string; image: Buffer }) => {
      session.status = 'waiting_scan';
      session.qrCodeUrl = event.url;
      session.qrCodeImage = Buffer.from(event.image);
      session.error = '';
      this.notify();
    });
    session.host.on('qrcode_state', (event: { state: string }) => {
      if (event.state === 'waiting_confirm') session.status = 'waiting_confirm';
      if (event.state === 'expired' || event.state === 'canceled' || event.state === 'invalid') {
        session.status = 'error';
        session.error = `二维码${event.state === 'expired' ? '已过期' : '已失效'}，请停止后重新登录`;
      }
      this.notify();
    });
    session.host.on('online', (event: { uin: string }) => {
      if (!/^\d{5,12}$/.test(event.uin)) {
        session.status = 'error';
        session.error = '协议宿主返回了无效 QQ 号';
        this.notify();
        return;
      }
      if (session.bound && session.uin !== event.uin) this.disconnectBridge(session);
      session.uin = event.uin;
      session.status = 'online';
      session.error = '';
      session.qrCodeImage = null;
      this.deps.bridgeManager.onHookLogin(session.syntheticPid, event.uin, session.host);
      session.bound = true;
      this.notify();
    });
    session.host.on('packet', (event: { command: string; sequence: number; retCode: number; body: Buffer }) => {
      if (!session.bound || !session.uin) return;
      this.deps.bridgeManager.onPacket({
        pid: session.syntheticPid,
        uin: session.uin,
        serviceCmd: event.command,
        seqId: event.sequence,
        retCode: event.retCode,
        fromClient: false,
        body: event.body,
      });
    });
    session.host.on('offline', (event: { reason: string }) => {
      this.disconnectBridge(session);
      session.status = 'disconnected';
      session.error = event.reason;
      this.notify();
    });
    session.host.on('host_error', (event: { message: string }) => {
      session.status = 'error';
      session.error = event.message;
      this.notify();
    });
    session.host.on('exit', () => {
      this.disconnectBridge(session);
      if (this.sessions.has(session.id) && session.status !== 'error') {
        session.status = 'disconnected';
        session.error = '内置协议宿主已退出';
        this.notify();
      }
    });
  }

  private disconnectBridge(session: ProtocolSession): void {
    if (!session.bound) return;
    session.bound = false;
    this.deps.bridgeManager.onPidDisconnected(session.syntheticPid);
  }

  private notify(): void {
    this.deps.onSessionsChanged?.();
  }
}

function toPublicInfo(session: ProtocolSession): ProtocolSessionInfo {
  return {
    id: session.id,
    status: session.status,
    uin: session.uin,
    qrCodeUrl: session.qrCodeUrl,
    error: session.error,
  };
}
