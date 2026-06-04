import { createLogger, type Logger } from '@snowluma/common/logger';
import type { ApiHandler } from '../api-handler';
import type { DispatchPayload } from '../event-filter';
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

export type AdapterStatusLevel = 'ok' | 'warn' | 'down' | 'disabled';

/** Live runtime status of a single network adapter, surfaced to the WebUI
 *  dashboard (and the per-node config cards) so the gateway's own
 *  connection health is visible. `detail` is a short human string, e.g.
 *  "3 个客户端" / "重连中" / "上次推送失败 14:53:01". */
export interface AdapterStatus {
  name: string;
  kind: 'httpServer' | 'httpClient' | 'wsServer' | 'wsClient';
  status: AdapterStatusLevel;
  detail: string;
}

export abstract class IOneBotNetworkAdapter<C extends NetworkBase> {
  readonly name: string;
  protected config: C;
  protected readonly ctx: NetworkAdapterContext;
  protected readonly log: Logger;
  protected isEnabled = false;

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

  abstract open(): void | Promise<void>;
  abstract close(): void | Promise<void>;

  abstract onEvent(event: JsonObject, payload: DispatchPayload): void | Promise<void>;

  /** Report live connection health for the WebUI dashboard. */
  abstract describeStatus(): AdapterStatus;

  // ── reload: shared hot-reload state machine (template method) ──────────
  //
  // All four adapters reconcile a live config swap identically: decide
  // whether the binding changed, whether the adapter should be enabled, and
  // then open/close to reach the target state. The skeleton lives here; the
  // three things that genuinely differ per adapter are the hooks below.
  //
  // NOTE: the returned `NetworkReloadType` is a *test-observability* seam.
  // The sole production caller (`instance.applyConfigDiff`) discards it —
  // it exists so tests can assert "which transition did this config cause"
  // without poking private state. Behaviour, not the label, is the contract.

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

    this.config = structuredClone(next);
    this.onConfigReplaced(next);

    const sigChanged = prevSig !== this.bindingSignature(next);
    if (sigChanged && wasEnabled) {
      await this.close();
      if (willEnable) {
        await this.open();
        return NetworkReloadType.Reopened;
      }
      return NetworkReloadType.Closed;
    }
    if (!wasEnabled && willEnable) {
      await this.open();
      return NetworkReloadType.Opened;
    }
    if (wasEnabled && !willEnable) {
      await this.close();
      return NetworkReloadType.Closed;
    }
    return NetworkReloadType.Normal;
  }
}
