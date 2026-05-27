import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { BridgeInterface, BridgeKind } from './bridge-interface';

/**
 * Abstract base for every concrete bridge transport (`InjectBridge`,
 * `ProtocolBridge`, …). Strictly transport: knows about wire-level
 * send, packet delivery to a single subscriber, and lifecycle.
 *
 * Subclasses provide:
 *
 *   1. `kind` / `id` / `uin` — discriminators used by `BridgeManager`
 *      to index live transports.
 *   2. `sendRawPacket` — the actual outbound wire path. `InjectBridge`
 *      forwards through a `PacketSender` (named-pipe to QQ.exe);
 *      `ProtocolBridge` will eventually drive a long-lived TCP login
 *      session.
 *
 * Inbound packets are routed via the `packetHandler_` slot: an
 * `Account` calls `setPacketHandler(...)` to subscribe, and the
 * owning `BridgeAdapter` calls `deliverPacket(pkt)` for every frame
 * the underlying runtime hands it.
 *
 * `Bridge` knows NOTHING about identity caches, the event bus, the
 * api hub, or the cmd-dispatch pipeline. That entire account-layer
 * machinery lives on `Account` (`@snowluma/core/account`).
 */
export abstract class Bridge implements BridgeInterface {
  abstract readonly kind: BridgeKind;
  abstract readonly id: string;
  abstract readonly uin: string;

  abstract sendRawPacket(
    serviceCmd: string,
    body: Uint8Array,
    timeoutMs?: number,
  ): Promise<SendPacketResult>;

  private packetHandler_: ((pkt: PacketInfo) => void) | null = null;
  private disposed_ = false;

  setPacketHandler(handler: ((pkt: PacketInfo) => void) | null): void {
    this.packetHandler_ = handler;
  }

  deliverPacket(pkt: PacketInfo): void {
    this.packetHandler_?.(pkt);
  }

  get isDisposed(): boolean { return this.disposed_; }

  dispose(): void {
    if (this.disposed_) return;
    this.disposed_ = true;
    this.packetHandler_ = null;
  }
}
