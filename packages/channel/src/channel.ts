import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { PacketInfo } from '@snowluma/common/protocol-types';
import type { ChannelInterface, ChannelKind } from './channel-interface';

/**
 * Abstract base for every concrete channel transport (`HookChannel`,
 * `SocketChannel`, …). Strictly transport: knows about wire-level
 * send, packet delivery to a single subscriber, and lifecycle.
 *
 * Subclasses provide:
 *
 *   1. `kind` / `id` / `uin` — discriminators used by the `Hub` (in
 *      `@snowluma/core`) to index live transports.
 *   2. `sendRawPacket` — the actual outbound wire path. `HookChannel`
 *      forwards through a `PacketSender` (named-pipe to QQ.exe);
 *      `SocketChannel` will eventually drive a long-lived TCP login
 *      session.
 *
 * Inbound packets are routed via the `packetHandler_` slot: `Hub`
 * wires `ChannelCtx.onPacket` (which calls `setPacketHandler` on
 * this channel) so each `Core` instance subscribes exactly once, and
 * the owning `ChannelAdapter` calls `deliverPacket(pkt)` for every
 * frame the underlying runtime hands it.
 *
 * `Channel` knows NOTHING about identity caches, the event bus, the
 * api hub, or the cmd-dispatch pipeline. That entire account-layer
 * machinery lives on `Core` (`@snowluma/core`).
 */
export abstract class Channel implements ChannelInterface {
  abstract readonly kind: ChannelKind;
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
