import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import {
  HookPipeRequestError,
  PIPE_STATUS_CONNECTION_UNAVAILABLE,
  QqHookClient,
  type QqHookSendReply,
} from './qq-hook-client';

export type OutboundHealthListener = (healthy: boolean) => void;

export class HookPacketClient implements PacketSender {
  private outboundHealthy = true;

  constructor(
    private readonly client: QqHookClient,
    private readonly onOutboundHealthChanged?: OutboundHealthListener,
  ) { }

  async sendPacket(serviceCmd: string, body: Buffer, timeoutMs = 15000): Promise<SendPacketResult> {
    if (!this.client.isLoggedIn) {
      return { success: false, gotResponse: false, errorCode: -1, errorMessage: 'qq_hook client is not logged in', responseData: null };
    }

    try {
      const reply = await this.client.send(serviceCmd, body, {
        wantReply: true,
        replyTimeoutMs: timeoutMs,
      }) as QqHookSendReply;
      this.setOutboundHealthy(true);
      return {
        success: reply.error === 0,
        gotResponse: true,
        errorCode: reply.error,
        errorMessage: reply.message || '',
        responseData: reply.body,
      };
    } catch (error) {
      if (error instanceof HookPipeRequestError
          && error.status === PIPE_STATUS_CONNECTION_UNAVAILABLE) {
        this.setOutboundHealthy(false);
      }
      return {
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: error instanceof Error ? error.message : String(error),
        responseData: null,
      };
    }
  }

  private setOutboundHealthy(healthy: boolean): void {
    if (this.outboundHealthy === healthy) return;
    this.outboundHealthy = healthy;
    this.onOutboundHealthChanged?.(healthy);
  }
}
