import type { PacketSender, SendPacketResult } from '@snowluma/common/packet-sender';
import { QqHookClient, type QqHookSendReply } from './qq-hook-client';

export class HookPacketClient implements PacketSender {
  constructor(private readonly client: QqHookClient) { }

  async sendPacket(serviceCmd: string, body: Buffer, timeoutMs = 15000): Promise<SendPacketResult> {
    if (!this.client.isLoggedIn) {
      return { success: false, gotResponse: false, errorCode: -1, errorMessage: 'qq_hook client is not logged in', responseData: null };
    }

    try {
      const reply = await this.client.send(serviceCmd, body, {
        wantReply: true,
        replyTimeoutMs: timeoutMs,
      }) as QqHookSendReply;
      return {
        success: reply.error === 0,
        gotResponse: true,
        errorCode: reply.error,
        errorMessage: reply.message || '',
        responseData: reply.body,
      };
    } catch (error) {
      return {
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: error instanceof Error ? error.message : String(error),
        responseData: null,
      };
    }
  }
}
