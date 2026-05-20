import { protobuf_encode } from '@snowluma/proton';
import type { Bridge } from '../bridge';
import { makeOidbEnvelope, runOidb } from '../bridge-oidb';
import { OidbBase } from '../proto/proton/oidb';
import type { C2CRecallRequest, GroupRecallRequest, OidbEssence, SsoReadedReportReq } from '../proto/proton/oidb-actions/base';

export async function recallGroupMessage(bridge: Bridge, groupId: number, sequence: number): Promise<void> {
  const request = protobuf_encode<GroupRecallRequest>({
    type: 1,
    groupUin: groupId,
    info: { sequence, random: 0, field3: 0 },
    settings: { field1: 0 },
  });
  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg', request);
  if (!result.success) throw new Error(result.errorMessage || 'recall group message failed');
}

export async function recallPrivateMessage(
  bridge: Bridge, userUin: number, clientSeq: number,
  msgSeq: number, random: number, timestamp: number,
): Promise<void> {
  const targetUid = await bridge.resolveUserUid(userUin);
  const request = protobuf_encode<C2CRecallRequest>({
    type: 1,
    targetUid,
    info: {
      clientSequence: clientSeq,
      random,
      messageId: BigInt((0x01000000 * 0x100000000) + random),
      timestamp,
      field5: 0,
      messageSequence: msgSeq,
    },
    settings: { field1: false, field2: false },
    field6: false,
  });
  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg', request);
  if (!result.success) throw new Error(result.errorMessage || 'recall private message failed');
}

export async function markPrivateMessageRead(
  bridge: Bridge,
  userId: number,
  msgSeq: number,
  timestamp: number = Math.floor(Date.now() / 1000),
): Promise<void> {
  const uid = await bridge.resolveUserUid(userId);

  const request = protobuf_encode<SsoReadedReportReq>({
    c2cList: [
      {
        uid,
        lastReadTime: BigInt(timestamp),
        lastReadSeq: BigInt(msgSeq),
      },
    ],
  });

  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoReadedReport', request);

  if (!result.success) {
    throw new Error(result.errorMessage || 'mark private message read failed');
  }
}

export async function markGroupMessageRead(
  bridge: Bridge,
  groupId: number,
  msgSeq: number,
): Promise<void> {
  const request = protobuf_encode<SsoReadedReportReq>({
    groupList: [
      {
        groupUin: BigInt(groupId),
        lastReadSeq: BigInt(msgSeq),
      },
    ],
  });

  const result = await bridge.sendRawPacket('trpc.msg.msg_svc.MsgService.SsoReadedReport', request);

  if (!result.success) {
    throw new Error(result.errorMessage || 'mark group message read failed');
  }
}

export async function setGroupEssence(bridge: Bridge, groupId: number, sequence: number, random: number, enable: boolean): Promise<void> {
  const subCmd = enable ? 1 : 2;
  const cmd = enable ? 'OidbSvcTrpcTcp.0xeac_1' : 'OidbSvcTrpcTcp.0xeac_2';
  const env = makeOidbEnvelope<OidbEssence>(0xEAC, subCmd, { groupUin: groupId, sequence, random });
  await runOidb(bridge, cmd, protobuf_encode<OidbBase<OidbEssence>>(env));
}
