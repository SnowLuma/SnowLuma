export const CLIENT_MESSAGE_RECEIPT_CMD = 'ClientMessageReceipt';

export interface PacketInfo {
    pid: number;
    uin: string;
    packetType?: number;
    serviceCmd: string;
    seqId: number;
    retCode: number;
    fromClient: boolean;
    source?: 'client-message';
    body: Uint8Array;
}
export type PacketSink = (packet: PacketInfo) => void;
