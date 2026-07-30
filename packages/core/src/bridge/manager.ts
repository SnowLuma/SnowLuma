import {
  createLogger,
  renderTraceBytes,
  runWithTraceRequest,
} from '@snowluma/common/logger';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { isRealUin } from '@snowluma/common/uin';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from './bridge';

export type SessionStartedCallback = (uin: string, bridge: Bridge) => void;
export type SessionClosedCallback = (uin: string, bridge: Bridge) => void;

interface QQSession {
  bridge: Bridge;
}

const log = createLogger('Bridge');
const packetLog = createLogger('Bridge.Packet');

export class BridgeManager {
  private sessions_ = new Map<string, QQSession>();
  private pidToUin_ = new Map<number, string>();

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
    const uin = this.pidToUin_.get(pid);
    if (!uin) return;

    this.detachPidFromSession(pid, uin);
  }

  onPidReceiveHealthChanged(pid: number, healthy: boolean): void {
    const uin = this.pidToUin_.get(pid);
    if (!uin) {
      const message = `BridgeManager invariant violated: receive health for unmapped PID=${pid}`;
      log.error(message);
      throw new Error(message);
    }

    const session = this.sessions_.get(uin);
    if (!session || !session.bridge.hasPid(pid)) {
      const message = `BridgeManager invariant violated: receive health PID=${pid} is not owned by UIN=${uin}`;
      log.error(message);
      throw new Error(message);
    }
    session.bridge.setPidReceiveHealthy(pid, healthy);
  }

  onHookLogin(pid: number, uin: string, packetClient: PacketSender): void {
    if (!isRealUin(uin)) return;

    const { session, created } = this.bindPid(pid, uin, packetClient, 'login');

    if (created) {
      log.debug('session started: UIN=%s', uin);
      this.fireSessionStarted(uin, session.bridge);
    }
  }

  onPacket(pkt: PacketInfo): void {
    runWithTraceRequest(() => this.onPacketInContext(pkt));
  }

  private onPacketInContext(pkt: PacketInfo): void {
    const startedAt = Date.now();
    packetLog.trace(() => [
      'packet_push serviceCmd=%j seqId=%d retCode=%d fromClient=%s pid=%d uin=%j length=%d body=%s',
      pkt.serviceCmd,
      pkt.seqId,
      pkt.retCode,
      pkt.fromClient,
      pkt.pid,
      pkt.uin,
      pkt.body.byteLength,
      renderTraceBytes(pkt.body),
    ]);
    if (!pkt.uin || !isRealUin(pkt.uin)) {
      packetLog.trace(() => [
        'packet_terminal serviceCmd=%j seqId=%d outcome=dropped reason=invalid_uin events=0 dispatched=0 elapsedMs=%d',
        pkt.serviceCmd,
        pkt.seqId,
        Date.now() - startedAt,
      ]);
      return;
    }
    const uin = pkt.uin;

    let completion: Promise<void>;
    let handedToPipeline = false;
    try {
      // A packet may be the first trustworthy observation that a live PID moved
      // to another UIN. Apply the exact same ownership transition as login so a
      // PID can never remain attached to two Bridges.
      const client = pkt.pid > 0 ? this.packetClientForPid(pkt.pid) : null;
      const { session, created } = client
        ? this.bindPid(pkt.pid, uin, client, 'packet')
        : this.ensureSession(uin);

      // Notify session started on first real packet
      if (created) {
        log.debug('session started: UIN=%s', uin);
        this.fireSessionStarted(uin, session.bridge);
      }

      // Dispatch packet to bridge. The pipeline preserves synchronous parsing and
      // dispatch; its promise only marks completion of any async enrichment.
      handedToPipeline = true;
      completion = session.bridge.onPacket(pkt);
    } catch (error) {
      this.tracePacketFailure(
        pkt,
        startedAt,
        handedToPipeline
          ? 'pipeline_failed'
          : 'routing_failed',
        error,
      );
      throw error;
    }
    void completion.catch((error) => {
      this.tracePacketFailure(
        pkt,
        startedAt,
        'pipeline_failed',
        error,
      );
    });
  }

  private tracePacketFailure(
    pkt: PacketInfo,
    startedAt: number,
    reason: 'routing_failed' | 'pipeline_failed',
    error: unknown,
  ): void {
    packetLog.trace(() => [
      'packet_terminal serviceCmd=%j seqId=%d outcome=failed reason=%s error=%j events=0 dispatched=0 elapsedMs=%d',
      pkt.serviceCmd,
      pkt.seqId,
      reason,
      error instanceof Error ? error.message : String(error),
      Date.now() - startedAt,
    ]);
    log.error(
      'packet %s failed for %s: %s',
      reason === 'routing_failed'
        ? 'routing'
        : 'pipeline',
      pkt.serviceCmd,
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }

  /** Bind PID + sender as one state transition. If the PID changed accounts,
   *  the old Bridge is fully detached (and, when empty, closed) before the new
   *  Bridge is created. */
  private bindPid(
    pid: number,
    uin: string,
    packetClient: PacketSender,
    source: 'login' | 'packet',
  ): { session: QQSession; created: boolean } {
    const previousUin = this.pidToUin_.get(pid);
    if (previousUin && previousUin !== uin) {
      log.warn(
        'PID ownership changed: PID=%d UIN=%s -> UIN=%s source=%s',
        pid,
        previousUin,
        uin,
        source,
      );
      this.detachPidFromSession(pid, previousUin);
    }

    const result = this.ensureSession(uin);
    result.session.bridge.bindPid(pid, packetClient);
    this.pidToUin_.set(pid, uin);
    return result;
  }

  private packetClientForPid(pid: number): PacketSender | null {
    const uin = this.pidToUin_.get(pid);
    if (!uin) return null;

    const session = this.sessions_.get(uin);
    if (!session) {
      const message = `BridgeManager invariant violated: PID=${pid} references missing UIN=${uin} session`;
      log.error(message);
      throw new Error(message);
    }

    const packetClient = session.bridge.packetClientForPid(pid);
    if (packetClient) return packetClient;

    const message = `BridgeManager invariant violated: PID=${pid} has no sender in UIN=${uin} session`;
    log.error(message);
    throw new Error(message);
  }

  private detachPidFromSession(pid: number, uin: string): void {
    const mappedUin = this.pidToUin_.get(pid);
    if (mappedUin !== uin) {
      const message = `BridgeManager invariant violated: PID=${pid} detach expected UIN=${uin}, mapped UIN=${mappedUin ?? 'none'}`;
      log.error(message);
      throw new Error(message);
    }

    const session = this.sessions_.get(uin);
    if (!session) {
      const message = `BridgeManager invariant violated: PID=${pid} references missing UIN=${uin} session`;
      log.error(message);
      throw new Error(message);
    }

    if (!session.bridge.hasPid(pid)) {
      const message = `BridgeManager invariant violated: PID=${pid} is mapped to UIN=${uin}, but Bridge does not own the PID`;
      log.error(message);
      throw new Error(message);
    }
    if (!session.bridge.packetClientForPid(pid)) {
      const message = `BridgeManager invariant violated: PID=${pid} is mapped to UIN=${uin}, but Bridge has no sender for the PID`;
      log.error(message);
      throw new Error(message);
    }

    // Validation is complete. Mutate both sides only after the ownership
    // invariant is known to hold, so a fail-fast error preserves the evidence.
    this.pidToUin_.delete(pid);
    session.bridge.detachPid(pid);
    if (!session.bridge.empty) return;

    this.sessions_.delete(uin);
    log.debug('session closed: UIN=%s', uin);
    // Fire before dispose() so listeners can still read bridge.identity.
    this.fireSessionClosed(uin, session.bridge);
    session.bridge.dispose();
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
