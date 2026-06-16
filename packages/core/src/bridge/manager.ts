import { createLogger } from '@snowluma/common/logger';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from './bridge';

export type SessionStartedCallback = (uin: string, bridge: Bridge) => void;
export type SessionClosedCallback = (uin: string, bridge: Bridge) => void;

interface QQSession {
  bridge: Bridge;
}

const log = createLogger('Bridge');

export class BridgeManager {
  private sessions_ = new Map<string, QQSession>();
  private pidToUin_ = new Map<number, string>();
  private pidPacketClients_ = new Map<number, PacketSender>();

  private sessionStartedListeners_: SessionStartedCallback[] = [];
  private sessionClosedListeners_: SessionClosedCallback[] = [];

  /** Additive subscription: every observer (OneBotManager, NotificationManager,
   *  …) receives every session edge. (Was a single `set*Callback` setter —
   *  converted to N listeners so a second observer can't clobber the first.)
   *  The close edge now carries the bridge too, since callers read the last
   *  nickname before it is disposed. */
  addSessionStartedListener(cb: SessionStartedCallback): void {
    this.sessionStartedListeners_.push(cb);
  }
  addSessionClosedListener(cb: SessionClosedCallback): void {
    this.sessionClosedListeners_.push(cb);
  }

  private fireSessionStarted(uin: string, bridge: Bridge): void {
    for (const cb of this.sessionStartedListeners_) {
      try {
        cb(uin, bridge);
      } catch (err) {
        log.warn('session-started listener threw: %s', err instanceof Error ? err.message : String(err));
      }
    }
  }

  private fireSessionClosed(uin: string, bridge: Bridge): void {
    for (const cb of this.sessionClosedListeners_) {
      try {
        cb(uin, bridge);
      } catch (err) {
        log.warn('session-closed listener threw: %s', err instanceof Error ? err.message : String(err));
      }
    }
  }

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
      // Fire before dispose() so listeners can still read bridge.identity.
      this.fireSessionClosed(uin, session.bridge);
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
      this.fireSessionStarted(uin, session.bridge);
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
      this.fireSessionStarted(uin, session.bridge);
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
