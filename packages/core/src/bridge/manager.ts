// BridgeManager — manages per-UIN Bridge sessions.
// onPacket() is the single entry point for parsed hook packets;
// HookManager wires it as the default packet sink for every HookSession.
// Port of src/bridge/include/bridge/manager.h + src/bridge/src/manager.cpp

import type { PacketInfo } from '../protocol/types';
import { Bridge } from './bridge';
import { IdentityService } from './identity-service';
import type { PacketSender } from '../protocol/packet-sender';
import { createLogger } from '../utils/logger';

export type SessionStartedCallback = (uin: string, bridge: Bridge) => void;
export type SessionClosedCallback = (uin: string) => void;

interface QQSession {
  bridge: Bridge;
}

const log = createLogger('Bridge');

export class BridgeManager {
  private sessions_ = new Map<string, QQSession>();
  private pidToUin_ = new Map<number, string>();
  private pidPacketClients_ = new Map<number, PacketSender>();

  private onSessionStarted_: SessionStartedCallback | null = null;
  private onSessionClosed_: SessionClosedCallback | null = null;

  setSessionStartedCallback(cb: SessionStartedCallback): void { this.onSessionStarted_ = cb; }
  setSessionClosedCallback(cb: SessionClosedCallback): void { this.onSessionClosed_ = cb; }

  onPidDisconnected(pid: number): void {
    this.pidPacketClients_.delete(pid);
    const uin = this.pidToUin_.get(pid);
    if (!uin) return;

    this.pidToUin_.delete(pid);
    const session = this.sessions_.get(uin);
    if (!session) return;

    session.bridge.detachPid(pid);
    if (session.bridge.empty) {
      this.sessions_.delete(uin);
      log.debug('session closed: UIN=%s', uin);
      if (this.onSessionClosed_) this.onSessionClosed_(uin);
      session.bridge.dispose();
    }
  }

  private static isRealUin(uin: string): boolean {
    if (!uin || uin === '0') return false;
    return /^\d+$/.test(uin) && uin.length >= 5;
  }

  onHookLogin(pid: number, uin: string, packetClient: PacketSender): void {
    if (!BridgeManager.isRealUin(uin)) return;

    this.pidPacketClients_.set(pid, packetClient);

    const { session, created } = this.ensureSession(uin);
    session.bridge.attachPid(pid);
    session.bridge.setPacketClient(packetClient);
    this.pidToUin_.set(pid, uin);

    if (created) {
      log.debug('session started: UIN=%s', uin);
      if (this.onSessionStarted_) {
        this.onSessionStarted_(uin, session.bridge);
      }
    }
  }

  onPacket(pkt: PacketInfo): void {
    if (!pkt.uin || !BridgeManager.isRealUin(pkt.uin)) return;
    const uin = pkt.uin;

    // Ensure session exists
    const { session, created } = this.ensureSession(uin);

    // Attach PID if known
    if (pkt.pid && this.pidPacketClients_.has(pkt.pid)) {
      session.bridge.attachPid(pkt.pid);
      this.pidToUin_.set(pkt.pid, uin);

      const client = this.pidPacketClients_.get(pkt.pid);
      if (client) session.bridge.setPacketClient(client);
    }

    // Notify session started on first real packet
    if (created) {
      log.debug('session started: UIN=%s', uin);
      if (this.onSessionStarted_) {
        this.onSessionStarted_(uin, session.bridge);
      }
    }

    // Dispatch packet to bridge
    session.bridge.onPacket(pkt);
  }

  private ensureSession(uin: string): { session: QQSession; created: boolean } {
    let session = this.sessions_.get(uin);
    if (session) return { session, created: false };

    const bridge = new Bridge(IdentityService.openForUin(uin));
    session = { bridge };
    this.sessions_.set(uin, session);

    // Each downstream consumer (e.g. OneBotInstance) subscribes to
    // `bridge.events` directly via the per-kind bus — there is no longer a
    // generic firehose to wire here.
    return { session, created: true };
  }

  getSession(uin: string): QQSession | null {
    return this.sessions_.get(uin) ?? null;
  }

  get sessions(): Map<string, { bridge: Bridge }> {
    return this.sessions_;
  }
}
