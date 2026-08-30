// MessageApi recall + markRead coverage. (The send* paths live in their
// own test file because they need element-builder fixtures the recall
// paths don't.) Renamed from the legacy `actions/group-message` shape
// after #6 commit 1 moved the recall + markRead helpers onto MessageApi
// and #6 commit 6 absorbed setEssence into InteractionApi.

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { protobuf_decode, protobuf_encode } from '@snowluma/proton';
import type {
  C2CRecallRequest,
  SsoReadedReportReq,
  SsoReadedReportResp,
} from '@snowluma/proto-defs/oidb-actions/base';

vi.mock('@snowluma/protocol/bridge-oidb', () => ({
  runOidb: vi.fn(async () => new Uint8Array()),
  makeOidbEnvelope: vi.fn((_oidbCmd, _subCmd, body) => ({ body })),
  encodeOidbEnv: vi.fn(() => new Uint8Array()),
  decodeOidbEnv: vi.fn(() => ({ body: {} })),
}));

import { MessageApi } from '../../src/bridge/apis/message';
import { mockBridge } from './_helpers';

function readReportResult(response: SsoReadedReportResp) {
  return {
    success: true,
    gotResponse: true,
    errorCode: 0,
    errorMessage: '',
    responseData: Buffer.from(protobuf_encode<SsoReadedReportResp>(response)),
  };
}

describe('apis/message — recall + markRead', () => {
  beforeEach(() => {
    // No global mock state to reset — sendRawPacket is per-bridge.
  });

  it('recallGroup sends to SsoGroupRecallMsg with the group sequence', async () => {
    const bridge = mockBridge();
    await new MessageApi(bridge as any).recallGroup(12345, 999);
    expect(bridge.sendRawPacket).toHaveBeenCalledOnce();
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.msg.msg_svc.MsgService.SsoGroupRecallMsg');
  });

  it('recallGroup throws when sendRawPacket reports failure', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => ({
        success: false,
        gotResponse: false,
        errorCode: -1,
        errorMessage: 'network down',
        responseData: null,
      })) as any,
    });
    await expect(new MessageApi(bridge as any).recallGroup(12345, 999))
      .rejects.toThrow(/network down/);
  });

  it('recallPrivate resolves the target UID before dispatch', async () => {
    const bridge = mockBridge();
    await new MessageApi(bridge as any).recallPrivate(10001, 100, 200, 123, 1700000000);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);
    const [serviceCmd] = bridge.sendRawPacket.mock.calls[0]!;
    expect(serviceCmd).toBe('trpc.msg.msg_svc.MsgService.SsoC2CRecallMsg');
  });

  it('recallPrivate keeps the 64-bit message id exact for any random', async () => {
    const random = 0x1234567;
    const bridge = mockBridge();
    await new MessageApi(bridge as any).recallPrivate(10001, 11110, 200, random, 1700000000);

    const [, body] = bridge.sendRawPacket.mock.calls[0]!;
    const request = protobuf_decode<C2CRecallRequest>(body);
    expect(request.info?.random).toBe(random);
    expect(request.info?.messageId).toBe(0x0100000001234567n);
  });

  it('probes and confirms group plus private reads in the same packets', async () => {
    const sendRawPacket = vi.fn()
      .mockResolvedValueOnce(readReportResult({
        groupList: [{ groupUin: 1081372778n, readSeq: 66569n, latestSeq: 66629n }],
        c2cList: [{
          uid: 'resolved-uid',
          readSeq: 160n,
          latestSeq: 171n,
          lastMsgTime: 1783952859n,
        }],
      }))
      .mockResolvedValueOnce(readReportResult({
        groupList: [{ groupUin: 1081372778n, readSeq: 66629n, latestSeq: 66629n }],
        c2cList: [{
          uid: 'resolved-uid',
          readSeq: 171n,
          latestSeq: 171n,
          lastMsgTime: 1783952859n,
        }],
      }));
    const bridge = mockBridge({ sendRawPacket });

    await new MessageApi(bridge as any).markAllRead([1081372778], [10001]);

    expect(sendRawPacket).toHaveBeenCalledTimes(2);
    expect(sendRawPacket.mock.calls.map((call: any) => call[0])).toEqual([
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
      'trpc.msg.msg_svc.MsgService.SsoReadedReport',
    ]);
    expect(bridge.resolveUserUid).toHaveBeenCalledWith(10001);

    const probeBytes = sendRawPacket.mock.calls[0]![1];
    expect(Buffer.from(probeBytes).toString('hex')).toBe(
      '0a0608eae0d18304120e120c7265736f6c7665642d756964',
    );
    const probe = protobuf_decode<SsoReadedReportReq>(probeBytes);
    expect(probe).toEqual({
      groupList: [{ groupUin: 1081372778n, lastReadSeq: null }],
      c2cList: [{ uid: 'resolved-uid', lastReadTime: null, lastReadSeq: null }],
    });

    const confirm = protobuf_decode<SsoReadedReportReq>(sendRawPacket.mock.calls[1]![1]);
    expect(confirm).toEqual({
      groupList: [{ groupUin: 1081372778n, lastReadSeq: 66629n }],
      c2cList: [{
        uid: 'resolved-uid',
        lastReadTime: 1783952859n,
        lastReadSeq: 171n,
      }],
    });
  });

  it('does not send a confirm packet when every read marker is current', async () => {
    const sendRawPacket = vi.fn(async () => readReportResult({
      groupList: [{ groupUin: 12345n, readSeq: 50n, latestSeq: 50n }],
    }));
    const bridge = mockBridge({ sendRawPacket });

    await new MessageApi(bridge as any).markGroupRead(12345);

    expect(sendRawPacket).toHaveBeenCalledOnce();
  });

  it('markGroupRead rejects a transport success with no business response', async () => {
    const bridge = mockBridge();
    await expect(new MessageApi(bridge as any).markGroupRead(12345))
      .rejects.toThrow(/response is empty/);
  });

  it('markGroupRead surfaces the per-group business error', async () => {
    const bridge = mockBridge({
      sendRawPacket: vi.fn(async () => readReportResult({
        groupList: [{ resultCode: 100000010, errorMessage: 'send group msg failed, ret:2' }],
      })),
    });
    await expect(new MessageApi(bridge as any).markGroupRead(1))
      .rejects.toThrow(/send group msg failed, ret:2/);
  });

  it('rejects a top-level success when the private read marker did not advance', async () => {
    const sendRawPacket = vi.fn()
      .mockResolvedValueOnce(readReportResult({
        c2cList: [{
          uid: 'resolved-uid',
          readSeq: 160n,
          latestSeq: 171n,
          lastMsgTime: 1783952859n,
        }],
      }))
      .mockResolvedValueOnce(readReportResult({
        c2cList: [{
          uid: 'resolved-uid',
          readSeq: 160n,
          latestSeq: 171n,
          lastMsgTime: 1783952859n,
        }],
      }));
    const bridge = mockBridge({ sendRawPacket });

    await expect(new MessageApi(bridge as any).markPrivateRead(10001))
      .rejects.toThrow(/confirmed sequence 160 before requested 171/);
  });

  it('caps mixed read reports at 100 + 100 and confirms each page before probing the next', async () => {
    const sendRawPacket = vi.fn(async (_cmd: string, body: Uint8Array) => {
      const request = protobuf_decode<SsoReadedReportReq>(body);
      return readReportResult({
        groupList: request.groupList?.map(item => {
          const requested = item.lastReadSeq ?? 0n;
          return {
            groupUin: item.groupUin,
            readSeq: requested,
            latestSeq: requested === 0n ? 1n : requested,
          };
        }),
        c2cList: request.c2cList?.map(item => {
          const requested = item.lastReadSeq ?? 0n;
          return {
            uid: item.uid,
            readSeq: requested,
            latestSeq: requested === 0n ? 1n : requested,
            lastMsgTime: 1700000000n,
          };
        }),
      });
    });
    const resolveUserUid = vi.fn(async (userId: number) => `uid-${userId}`);
    const bridge = mockBridge({ sendRawPacket, resolveUserUid });
    const groups = Array.from({ length: 101 }, (_, i) => 1000 + i);
    const users = Array.from({ length: 101 }, (_, i) => 2000 + i);

    await new MessageApi(bridge as any).markAllRead(groups, users);

    expect(sendRawPacket).toHaveBeenCalledTimes(4);
    const requests = sendRawPacket.mock.calls.map((call: any) =>
      protobuf_decode<SsoReadedReportReq>(call[1]));
    expect(requests.map(request => [request.groupList?.length, request.c2cList?.length])).toEqual([
      [100, 100],
      [100, 100],
      [1, 1],
      [1, 1],
    ]);
    expect(requests[0]!.groupList![0]!.lastReadSeq).toBeNull();
    expect(requests[1]!.groupList![0]!.lastReadSeq).toBe(1n);
    expect(requests[2]!.groupList![0]!.lastReadSeq).toBeNull();
    expect(requests[3]!.groupList![0]!.lastReadSeq).toBe(1n);
  });
});
