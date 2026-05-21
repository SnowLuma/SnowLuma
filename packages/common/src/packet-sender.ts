export interface SendPacketResult {
  success: boolean;
  gotResponse: boolean;
  errorCode: number;
  errorMessage: string;
  responseData: Buffer | null;
}

export interface PacketSender {
  sendPacket(serviceCmd: string, body: Buffer, timeoutMs?: number): Promise<SendPacketResult>;
}
