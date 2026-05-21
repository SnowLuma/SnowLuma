export interface PacketInfo {
  pid: number;
  uin: string;
  packetType?: number;
  serviceCmd: string;
  seqId: number;
  retCode: number;
  fromClient: boolean;
  body: Uint8Array;
}
export type PacketSink = (packet: PacketInfo) => void;
