import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type { SendPacketResult } from '@snowluma/common/packet-sender';
import type { QidianCorpInfoRequest, QidianCorpInfoResponse } from '@snowluma/proto-defs/qidian-corp';

// 企点企业资料卡（trpc.basic.corp.Datacard.SsoCorpInfo）。
// 请求体为 protobuf field1 = 目标账号 UIN（varint）
// 返回企业名称等资料卡字段（来源见 SnowLuma issue #404 讨论）。
export const QIDIAN_CORP_INFO_CMD = 'trpc.basic.corp.Datacard.SsoCorpInfo';

export interface QidianCorpInfo {
  name: string;
  intro: string;
  website: string;
  slogan: string;
  address: string;
  phone: string;
  email: string;
}

export interface RawSender {
  sendRawPacket(serviceCmd: string, body: Uint8Array, timeoutMs?: number): Promise<SendPacketResult>;
}

/**
 * Fetch the qidian enterprise data-card for a qidian account UIN.
 * Returns null when the account is not a qidian corp user or the server
 * returns no corp info. Best-effort by design — callers must NOT fail the
 * whole profile read if this lookup throws / returns null.
 */
export async function fetchQidianCorpInfo(
  sender: RawSender,
  uin: number,
  timeoutMs?: number,
): Promise<QidianCorpInfo | null> {
  const req = protobuf_encode<QidianCorpInfoRequest>({ uin });
  const result = await sender.sendRawPacket(QIDIAN_CORP_INFO_CMD, req, timeoutMs);
  if (!result.success || !result.gotResponse || !result.responseData || result.responseData.length === 0) {
    return null;
  }
  const decoded = protobuf_decode<QidianCorpInfoResponse>(result.responseData);
  const name = decoded?.corpName ?? '';
  if (!name) return null;
  return {
    name,
    intro: decoded?.intro ?? '',
    website: decoded?.website ?? '',
    slogan: decoded?.slogan ?? '',
    address: decoded?.address ?? '',
    phone: decoded?.phone ?? '',
    email: decoded?.email ?? '',
  };
}
