import { createLogger, type Logger } from '@snowluma/common/logger';
import type { ApiHandler } from '../api-handler';
import { shapeEventForAdapter, type DispatchPayload, type EventReportOptions } from '../event-filter';
import type { JsonObject, NetworkBase } from '../types';

export interface NetworkAdapterContext {
  uin: string;
  api: ApiHandler;
  buildLifecycleEvent(subType: 'connect' | 'enable' | 'disable'): JsonObject;
  buildHeartbeatEvent(): JsonObject;
}

export enum NetworkReloadType {
  Normal = 0,
  Reopened = 1,
  Closed = 2,
  Opened = 3,
}

export type AdapterStatusLevel = 'ok' | 'warn' | 'down' | 'disabled' | 'degraded';

/** Live runtime status of a single network adapter, surfaced to the WebUI
 *  dashboard (and the per-node config cards) so the gateway's own
 *  connection health is visible. `detail` is a short human string, e.g.
 *  "3 个客户端" / "重连中" / "上次推送失败 14:53:01". */
export interface AdapterStatus {
  name: string;
  kind: 'httpServer' | 'httpClient' | 'wsServer' | 'wsClient';
  status: AdapterStatusLevel;
  detail: string;
  /** Present when the desired config could not be applied or the bound
   *  transport later failed. The adapter may still be serving its restored
   *  previous config; `degraded` describes reconciliation, not only liveness. */
  lastError?: string;
  lastErrorAt?: number;
}

export abstract class IOneBotNetworkAdapter<C extends NetworkBase> {
  readonly name: string;
  protected config: C;
  protected readonly ctx: NetworkAdapterContext;
  protected readonly log: Logger;
  protected isEnabled = false;
  private applyFailure: { message: string; at: number } | null = null;

  constructor(name: string, config: C, ctx: NetworkAdapterContext, moduleLog?: Logger) {
    this.name = name;
    this.config = structuredClone(config);
    this.ctx = ctx;
    const base = moduleLog ?? createLogger('OneBot.Network');
    const uinNum = Number.parseInt(ctx.uin, 10);
    this.log = Number.isFinite(uinNum) && uinNum > 0 ? base.child({ uin: uinNum }) : base;
  }

  get isActive(): boolean { return this.isEnabled; }

  get currentConfig(): Readonly<C> { return this.config; }

  get hasApplyFailure(): boolean { return this.applyFailure !== null; }

  abstract open(): void | Promise<void>;
  abstract close(): void | Promise<void>;

  abstract onEvent(event: JsonObject, payload: DispatchPayload): void | Promise<void>;

  /** Report live connection health for the WebUI dashboard. */
  abstract describeStatus(): AdapterStatus;

  /** Status with the manager-owned desired/live mismatch overlaid. Concrete
   *  adapters continue to describe transport health; reconciliation failures
   *  are kept here so a successfully restored old binding is still visible. */
  describeManagedStatus(): AdapterStatus {
    const status = this.describeStatus();
    if (!this.applyFailure) return status;
    return {
      ...status,
      status: 'degraded',
      detail: `应用失败：${this.applyFailure.message}`,
      lastError: this.applyFailure.message,
      lastErrorAt: this.applyFailure.at,
    };
  }

  /** NetworkManager lifecycle seam. A failure is cleared only after a later
   *  reconciliation reaches the desired state. */
  markApplyFailure(error: unknown, at = Date.now()): void {
    this.applyFailure = { message: errorMessage(error), at };
  }

  clearApplyFailure(): void {
    this.applyFailure = null;
  }

  protected recordTransportFailure(error: unknown, at = Date.now()): void {
    this.markApplyFailure(error, at);
  }

  // ── meta-event framing: shared by the connection-oriented adapters ─────
  //
  // Lifecycle (connect/enable/disable) and heartbeat meta events don't flow
  // through `OneBotNetworkManager.emitEvent` (no pre-serialized DispatchPayload),
  // so each connection-oriented adapter shapes them per its report options and
  // serializes on the spot. The shape+serialize policy lives here once; the
  // adapters only own the transport (which socket(s) to `safeSend` to).

  /** Shape one meta event for `options` and serialize it to a wire frame, or
   *  `null` when the shaper drops it (e.g. a self-message under
   *  `reportSelfMessage:false`). */
  protected metaFrame(event: JsonObject, options: EventReportOptions): string | null {
    const shaped = shapeEventForAdapter(event, options);
    return shaped === null ? null : JSON.stringify(shaped);
  }

  /** The bootstrap meta frames an event client receives on (re)connect:
   *  `connect`, `enable`, then a `heartbeat`, shaped for `options`. Frames the
   *  shaper drops are omitted. */
  protected bootstrapMetaFrames(options: EventReportOptions): string[] {
    const events = [
      this.ctx.buildLifecycleEvent('connect'),
      this.ctx.buildLifecycleEvent('enable'),
      this.ctx.buildHeartbeatEvent(),
    ];
    const frames: string[] = [];
    for (const event of events) {
      const frame = this.metaFrame(event, options);
      if (frame !== null) frames.push(frame);
    }
    return frames;
  }

  // ── reload: shared hot-reload state machine (template method) ──────────
  //
  // All four adapters reconcile a live config swap identically: decide
  // whether the binding changed, whether the adapter should be enabled, and
  // then open/close to reach the target state. The skeleton lives here; the
  // three things that genuinely differ per adapter are the hooks below.
  //
  // NOTE: the returned `NetworkReloadType` is a *test-observability* seam.
  // OneBotNetworkManager awaits the transition but derives apply truth from
  // success/failure rather than this label. Tests use it to assert "which
  // transition did this config cause" without poking private state.
  // Behaviour, not the label, is the contract.

  /** Stable string identity of the bound resource (host:port / url / token …).
   *  A change here means the live binding must be torn down and re-opened. */
  protected abstract bindingSignature(config: C): string;

  /** Whether `config` should result in an enabled adapter. Defaults to the
   *  `enabled` flag; client adapters also require a target `url`. */
  protected willEnable(config: C): boolean {
    return config.enabled !== false;
  }

  /** Refresh derived state after `this.config` has been replaced (report
   *  options, role, propagation to live connections). Default: nothing. */
  protected onConfigReplaced(_next: C): void { /* no-op */ }

  async reload(next: C): Promise<NetworkReloadType> {
    const prevSig = this.bindingSignature(this.config);
    const wasEnabled = this.isEnabled;
    const willEnable = this.willEnable(next);
    const sigChanged = prevSig !== this.bindingSignature(next);

    // Keep currentConfig truthful while the old live resource is being
    // released. Only publish the desired config after close succeeds; an
    // opening adapter necessarily sees the new config, while a close failure
    // leaves the previous config intact for recovery and diagnostics.
    if (wasEnabled && (sigChanged || !willEnable)) {
      await this.close();
      this.replaceConfig(next);
      if (willEnable) {
        await this.open();
        return NetworkReloadType.Reopened;
      }
      return NetworkReloadType.Closed;
    }

    this.replaceConfig(next);
    if (!wasEnabled && willEnable) {
      await this.open();
      return NetworkReloadType.Opened;
    }
    return NetworkReloadType.Normal;
  }

  private replaceConfig(next: C): void {
    this.config = structuredClone(next);
    this.onConfigReplaced(next);
  }
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
