import type { ApiHandler } from '../api-handler';
import type { DispatchPayload } from '../event-filter';
import type { JsonObject, NetworkBase } from '../types';

export interface NetworkAdapterContext {
  /** Self UIN as string — written into outbound headers. */
  uin: string;
  /** Shared API dispatcher used by request/response style adapters. */
  api: ApiHandler;
  /** Build a lifecycle event payload (connect/enable/disable). */
  buildLifecycleEvent(subType: 'connect' | 'enable' | 'disable'): JsonObject;
  /** Build a heartbeat event payload. */
  buildHeartbeatEvent(): JsonObject;
}

export enum NetworkReloadType {
  /** Configuration unchanged or only soft fields updated. */
  Normal = 0,
  /** Underlying socket/listener restarted in place. */
  Reopened = 1,
  /** Was running, now closed. */
  Closed = 2,
  /** Was idle, now opened. */
  Opened = 3,
}

export abstract class IOneBotNetworkAdapter<C extends NetworkBase> {
  readonly name: string;
  protected config: C;
  protected readonly ctx: NetworkAdapterContext;
  protected isEnabled = false;

  constructor(name: string, config: C, ctx: NetworkAdapterContext) {
    this.name = name;
    // Defensive copy so reload diffs never mutate the caller's object.
    this.config = structuredClone(config);
    this.ctx = ctx;
  }

  /** Whether the adapter is currently accepting/relaying events. */
  get isActive(): boolean { return this.isEnabled; }

  /** Snapshot of the active config (read-only). */
  get currentConfig(): Readonly<C> { return this.config; }

  abstract open(): void | Promise<void>;
  abstract close(): void | Promise<void>;
  abstract reload(config: C): NetworkReloadType | Promise<NetworkReloadType>;

  /**
   * Receive one fully-shaped OneBot event for forwarding. Adapters that
   * don't push events (e.g. HTTP request-response servers) override with a
   * no-op.
   */
  abstract onEvent(event: JsonObject, payload: DispatchPayload): void | Promise<void>;
}
