import { createLogger, renderTraceBytes, runWithTraceRequest } from '@snowluma/common/logger';
import type { PacketSender } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import { isRealUin } from '@snowluma/common/uin';
import { IdentityService } from '@snowluma/protocol/identity-service';
import { Bridge } from './bridge';
import type { BridgeSessionListener, BridgeSessionSource } from './bridge-interface';

const log = createLogger('Bridge');
const packetLog = createLogger('Bridge.Packet');
const runtimeLog = createLogger('Bridge.Runtime');

export class BridgeManager implements BridgeSessionSource {
    private readonly bridges = new Map<string, Bridge>();
    private readonly pidToUin_ = new Map<number, string>();
    private readonly closingSessions_ = new Map<string, Set<Promise<void>>>();
    private readonly sessionSubscriptions = new Set<{ listener: BridgeSessionListener }>();
    private disposal_: Promise<void> | null = null;

    /** Hook callbacks remain synchronous; shutdown awaits every detached account. */
    dispose(): Promise<void> {
        this.sessionSubscriptions.clear();
        // Finish synchronous lifecycle observers before collecting detached sessions.
        return (this.disposal_ ??= Promise.resolve().then(() => this.disposeSessions()));
    }

    private async disposeSessions(): Promise<void> {
        for (const [uin, session] of this.bridges) {
            this.closeSession(uin, session);
        }

        this.bridges.clear();
        this.pidToUin_.clear();
        const results = await Promise.allSettled(
            [...this.closingSessions_.values()].flatMap((sessions) => [...sessions]),
        );
        const errors = results.flatMap((result) =>
            result.status === 'rejected' ? [result.reason] : [],
        );

        if (errors.length) {
            throw new AggregateError(errors, 'Bridge persistence shutdown failed');
        }
    }

    private closeSession(uin: string, bridge: Bridge): void {
        const sessions = this.closingSessions_.get(uin) ?? new Set<Promise<void>>();
        const closing = bridge.dispose();
        sessions.add(closing);
        this.closingSessions_.set(uin, sessions);
        void closing.then(
            () => {
                sessions.delete(closing);

                if (sessions.size === 0) {
                    this.closingSessions_.delete(uin);
                }
            },
            (error) => {
                log.error(
                    'identity close failed: UIN=%s err=%s',
                    uin,
                    error instanceof Error ? (error.stack ?? error.message) : String(error),
                );
            },
        );
    }

    /** Listener changes take effect on the next event. Close observers run before
     *  Bridge disposal, so the final process and account identity remain readable. */
    subscribeSessions(listener: BridgeSessionListener): () => void {
        const subscription = { listener };
        this.sessionSubscriptions.add(subscription);

        return () => {
            this.sessionSubscriptions.delete(subscription);
        };
    }

    private fireSessionStarted(uin: string, bridge: Bridge): void {
        for (const { listener } of [...this.sessionSubscriptions]) {
            try {
                listener.started?.(uin, bridge);
            } catch (err) {
                log.warn(
                    'session-started listener threw: %s',
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
    }

    private fireSessionClosed(uin: string, bridge: Bridge, pid: number): void {
        for (const { listener } of [...this.sessionSubscriptions]) {
            try {
                listener.closed?.(uin, bridge, pid);
            } catch (err) {
                log.warn(
                    'session-closed listener threw: %s',
                    err instanceof Error ? err.message : String(err),
                );
            }
        }
    }

    onPidDisconnected(pid: number): void {
        const uin = this.pidToUin_.get(pid);

        if (!uin) {
            return;
        }

        runWithTraceRequest(() => {
            const startedAt = Date.now();
            runtimeLog.trace('bridge_detach_start pid=%d uin=%j', pid, uin);

            try {
                const closed = this.detachPidFromSession(pid, uin);
                const activePid = this.bridges.get(uin)?.activePid ?? null;

                if (closed) {
                    runtimeLog.trace(
                        'bridge_detach_branch pid=%d uin=%j branch=session_closed',
                        pid,
                        uin,
                    );
                }

                runtimeLog.trace(
                    'bridge_detach_terminal pid=%d uin=%j outcome=completed reason=%s activePid=%j elapsedMs=%d',
                    pid,
                    uin,
                    closed ? 'session_closed' : 'pid_detached',
                    activePid,
                    Date.now() - startedAt,
                );
            } catch (error) {
                runtimeLog.trace(
                    'bridge_detach_terminal pid=%d uin=%j outcome=failed reason=invariant_violation error=%j elapsedMs=%d',
                    pid,
                    uin,
                    error instanceof Error ? error.message : String(error),
                    Date.now() - startedAt,
                );
                throw error;
            }
        });
    }

    onPidReceiveHealthChanged(pid: number, healthy: boolean): void {
        if (this.disposal_) {
            return;
        }

        const uin = this.pidToUin_.get(pid);

        if (!uin) {
            const message = `BridgeManager invariant violated: receive health for unmapped PID=${pid}`;
            log.error(message);
            throw new Error(message);
        }

        const session = this.bridges.get(uin);

        if (!session || !session.hasPid(pid)) {
            const message = `BridgeManager invariant violated: receive health PID=${pid} is not owned by UIN=${uin}`;
            log.error(message);
            throw new Error(message);
        }

        session.setPidReceiveHealthy(pid, healthy);
    }

    onHookLogin(pid: number, uin: string, packetClient: PacketSender): void {
        if (this.disposal_ || !isRealUin(uin)) {
            return;
        }

        runWithTraceRequest(() => {
            const startedAt = Date.now();
            const previousUin = this.pidToUin_.get(pid) ?? null;
            runtimeLog.trace(
                'bridge_binding_start pid=%d uin=%j source=login previousUin=%j',
                pid,
                uin,
                previousUin,
            );

            try {
                const { session, created } = this.bindPid(pid, uin, packetClient, 'login');

                if (previousUin && previousUin !== uin) {
                    runtimeLog.trace(
                        'bridge_binding_branch pid=%d uin=%j branch=account_rebind previousUin=%j',
                        pid,
                        uin,
                        previousUin,
                    );
                    const previousSession = this.bridges.get(previousUin);
                    runtimeLog.trace(
                        'bridge_binding_branch pid=%d uin=%j branch=%s previousUin=%j activePid=%j',
                        pid,
                        uin,
                        previousSession ? 'previous_session_retained' : 'previous_session_closed',
                        previousUin,
                        previousSession?.activePid ?? null,
                    );
                }

                if (created) {
                    runtimeLog.trace(
                        'bridge_binding_branch pid=%d uin=%j branch=session_created',
                        pid,
                        uin,
                    );
                    log.debug('session started: UIN=%s', uin);
                    this.fireSessionStarted(uin, session);
                }

                runtimeLog.trace(
                    'bridge_binding_terminal pid=%d uin=%j source=login outcome=completed reason=%s created=%s activePid=%j elapsedMs=%d',
                    pid,
                    uin,
                    previousUin && previousUin !== uin ? 'rebound' : 'bound',
                    created,
                    session.activePid,
                    Date.now() - startedAt,
                );
            } catch (error) {
                runtimeLog.trace(
                    'bridge_binding_terminal pid=%d uin=%j source=login outcome=failed reason=binding_failed error=%j elapsedMs=%d',
                    pid,
                    uin,
                    error instanceof Error ? error.message : String(error),
                    Date.now() - startedAt,
                );
                throw error;
            }
        });
    }

    onPacket(pkt: PacketInfo): void {
        if (this.disposal_) {
            return;
        }

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
                this.fireSessionStarted(uin, session);
            }

            // Dispatch packet to bridge. The pipeline preserves synchronous parsing and
            // dispatch; its promise only marks completion of any async enrichment.
            handedToPipeline = true;
            completion = session.onPacket(pkt);
        } catch (error) {
            this.tracePacketFailure(
                pkt,
                startedAt,
                handedToPipeline ? 'pipeline_failed' : 'routing_failed',
                error,
            );
            throw error;
        }

        void completion.catch((error) => {
            this.tracePacketFailure(pkt, startedAt, 'pipeline_failed', error);
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
            reason === 'routing_failed' ? 'routing' : 'pipeline',
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
    ): { session: Bridge; created: boolean } {
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
        result.session.bindPid(pid, packetClient);
        this.pidToUin_.set(pid, uin);
        return result;
    }

    private packetClientForPid(pid: number): PacketSender | null {
        const uin = this.pidToUin_.get(pid);

        if (!uin) {
            return null;
        }

        const session = this.bridges.get(uin);

        if (!session) {
            const message = `BridgeManager invariant violated: PID=${pid} references missing UIN=${uin} session`;
            log.error(message);
            throw new Error(message);
        }

        const packetClient = session.packetClientForPid(pid);

        if (packetClient) {
            return packetClient;
        }

        const message = `BridgeManager invariant violated: PID=${pid} has no sender in UIN=${uin} session`;
        log.error(message);
        throw new Error(message);
    }

    private detachPidFromSession(pid: number, uin: string): boolean {
        const mappedUin = this.pidToUin_.get(pid);

        if (mappedUin !== uin) {
            const message = `BridgeManager invariant violated: PID=${pid} detach expected UIN=${uin}, mapped UIN=${mappedUin ?? 'none'}`;
            log.error(message);
            throw new Error(message);
        }

        const session = this.bridges.get(uin);

        if (!session) {
            const message = `BridgeManager invariant violated: PID=${pid} references missing UIN=${uin} session`;
            log.error(message);
            throw new Error(message);
        }

        if (!session.hasPid(pid)) {
            const message = `BridgeManager invariant violated: PID=${pid} is mapped to UIN=${uin}, but Bridge does not own the PID`;
            log.error(message);
            throw new Error(message);
        }

        // Validation is complete. Mutate both sides only after the ownership
        // invariant is known to hold, so a fail-fast error preserves the evidence.
        this.pidToUin_.delete(pid);
        session.detachPid(pid);

        if (!session.empty) {
            return false;
        }

        this.bridges.delete(uin);
        log.debug('session closed: UIN=%s', uin);
        // Fire before dispose() so listeners can still read bridge.identity.
        this.fireSessionClosed(uin, session, pid);
        this.closeSession(uin, session);
        return true;
    }

    private ensureSession(uin: string): { session: Bridge; created: boolean } {
        const session = this.bridges.get(uin);

        if (session) {
            return { session, created: false };
        }

        const closing = this.closingSessions_.get(uin);
        // allSettled, not all: a failed close stays in the bookkeeping (so
        // dispose can still report it) but must not reject this gate — a
        // rejected gate would keep the identity DB of every future session
        // for this UIN closed until the process restarts.
        const beforeOpen = closing
            ? Promise.allSettled(closing).then(() => undefined)
            : undefined;
        const bridge = new Bridge(IdentityService.openForUin(uin, 'data', beforeOpen));
        this.bridges.set(uin, bridge);

        return { session: bridge, created: true };
    }

    getBridge(uin: string): Bridge | null {
        return this.bridges.get(uin) ?? null;
    }
}
